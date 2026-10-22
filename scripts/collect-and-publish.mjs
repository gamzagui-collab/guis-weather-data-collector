import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalObjectStore } from "../src/object-store.mjs";
import { runCollectorWorkflow } from "../src/workflow.mjs";
import {
  DownloadBudget, KOREA_BOUNDS, NOMADS_PRODUCT_DIRECTORY, downloadFrame,
  fetchText, parseCycles, parseRunDates, selectLatestRun, verifyRunComplete
} from "../src/noaa.mjs";

if (!process.argv.includes("--live")) throw new Error("GFS_LIVE_FLAG_REQUIRED");
if (!process.argv.includes("--local")) throw new Error("GFS_REMOTE_STORE_NOT_CONFIGURED");

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const work = resolve(process.env.GFS_WORK_DIRECTORY || resolve(packageRoot, ".work"));
const storeRoot = resolve(process.env.GFS_LOCAL_STORE || resolve(packageRoot, ".mock-r2"));
const pilotMode = process.env.GFS_PILOT_MODE === "true";
if (process.env.GITHUB_ACTIONS === "true" && !process.env.GFS_FORECAST_HOURS) throw new Error("GFS_PRODUCTION_FORECAST_HOURS_REQUIRED");
const requestedHours = (process.env.GFS_FORECAST_HOURS || "1,3,6,12").split(",").map(Number);
if (!requestedHours.length || requestedHours.some((hour) => !Number.isInteger(hour) || hour < 1 || hour > 384)) {
  throw new Error("GFS_FORECAST_HOURS_INVALID");
}
if (pilotMode && requestedHours.join(",") !== "1,3,6,12") throw new Error("GFS_PILOT_HOURS_INVALID");
const maxRequests = pilotMode ? 6 : requestedHours.length + 3;
const budget = new DownloadBudget({
  maxRequests,
  maxBytes: Number(process.env.GFS_MAX_DOWNLOAD_BYTES || 64 * 1024 * 1024)
});
const store = new LocalObjectStore(storeRoot);

function python(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const executable = process.env.GFS_PYTHON || "python";
    const configured = process.env.GFS_PYTHONPATH;
    const env = configured ? { ...process.env, PYTHONPATH: [configured, process.env.PYTHONPATH].filter(Boolean).join(delimiter) } : process.env;
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => code === 0 ? resolvePromise(stdout.trim()) : rejectPromise(new Error(`GFS_DECODER_EXIT_${code}:${stderr.slice(0, 400)}`)));
  });
}

async function discoverRun() {
  if (pilotMode) {
    const now = new Date();
    const cycleHour = Math.floor(now.getUTCHours() / 6) * 6;
    const current = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), cycleHour));
    const candidates = [current, new Date(current.valueOf() - 6 * 3_600_000)];
    for (const value of candidates) {
      const run = {
        runDate: `${value.getUTCFullYear()}${String(value.getUTCMonth() + 1).padStart(2, "0")}${String(value.getUTCDate()).padStart(2, "0")}`,
        cycle: String(value.getUTCHours()).padStart(2, "0"),
        modelRunAt: value.toISOString()
      };
      if (await verifyRunComplete(run, Math.max(...requestedHours), budget)) return run;
    }
    throw new Error("GFS_PILOT_RUN_NOT_COMPLETE");
  }
  const product = await fetchText(NOMADS_PRODUCT_DIRECTORY, budget);
  const dates = parseRunDates(product);
  if (!dates.length) throw new Error("GFS_PRODUCT_DIRECTORY_EMPTY");
  const latestDate = dates.at(-1);
  const cyclesHtml = await fetchText(new URL(`gfs.${latestDate}/`, NOMADS_PRODUCT_DIRECTORY), budget);
  const run = selectLatestRun([latestDate], { [latestDate]: parseCycles(cyclesHtml) });
  if (!await verifyRunComplete(run, Math.max(...requestedHours), budget)) throw new Error("GFS_LATEST_RUN_NOT_COMPLETE");
  return run;
}

async function collectDataset(run) {
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const files = [];
  for (const forecastHour of requestedHours) {
    const destination = resolve(work, `gfs-${run.runDate}-${run.cycle}-f${String(forecastHour).padStart(3, "0")}.grib2`);
    await downloadFrame({ run, forecastHour, destination, budget });
    files.push(destination);
  }
  const output = resolve(work, "gfs-grid.json");
  await python([
    resolve(packageRoot, "python/analyze_gfs_grid.py"), ...files,
    "--fetched-at", new Date().toISOString(),
    "--bounds", String(KOREA_BOUNDS.left), String(KOREA_BOUNDS.right), String(KOREA_BOUNDS.bottom), String(KOREA_BOUNDS.top),
    "--output", output
  ]);
  return JSON.parse(await readFile(output, "utf8"));
}

const result = await runCollectorWorkflow({ store, discoverRun, collectDataset });
const evidence = {
  schemaVersion: "weather.gfs.pilot-evidence.v1",
  generatedAt: new Date().toISOString(),
  pilotMode,
  forecastHours: requestedHours,
  result,
  budget: budget.snapshot()
};
await writeFile(resolve(storeRoot, "pilot-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
