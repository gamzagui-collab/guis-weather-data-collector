import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalObjectStore } from "../src/object-store.mjs";
import { runCollectorWorkflow } from "../src/workflow.mjs";
import {
  DownloadBudget, KOREA_BOUNDS, NOMADS_PRODUCT_DIRECTORY, downloadFrame,
  fetchText, listPublishedRuns, parseCycles, parseRunDates, verifyRunComplete
} from "../src/noaa.mjs";

if (!process.argv.includes("--live")) throw new Error("GFS_LIVE_FLAG_REQUIRED");
if (!process.argv.includes("--local")) throw new Error("GFS_REMOTE_STORE_NOT_CONFIGURED");

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const work = resolve(process.env.GFS_WORK_DIRECTORY || resolve(packageRoot, ".work"));
const storeRoot = resolve(process.env.GFS_LOCAL_STORE || resolve(packageRoot, ".mock-r2"));
if (process.env.GITHUB_ACTIONS === "true" && !process.env.GFS_FORECAST_HOURS) throw new Error("GFS_PRODUCTION_FORECAST_HOURS_REQUIRED");
const requestedHours = (process.env.GFS_FORECAST_HOURS || "1,3,6,12").split(",").map(Number);
if (!requestedHours.length || requestedHours.some((hour) => !Number.isInteger(hour) || hour < 1 || hour > 384)) {
  throw new Error("GFS_FORECAST_HOURS_INVALID");
}
const exact48Hours = Array.from({ length: 48 }, (_, index) => index + 1);
const collectionMode = process.env.GFS_COLLECTION_MODE || "PILOT";
if (!["PILOT", "48H"].includes(collectionMode)) throw new Error("GFS_COLLECTION_MODE_INVALID");
if (collectionMode === "48H" && JSON.stringify(requestedHours) !== JSON.stringify(exact48Hours)) {
  throw new Error("GFS_48H_FORECAST_HOURS_INVALID");
}
const maxRequests = Number(process.env.GFS_MAX_REQUESTS || requestedHours.length + 3);
if (!Number.isInteger(maxRequests) || maxRequests < requestedHours.length + 3 || maxRequests > 55) {
  throw new Error("GFS_MAX_REQUESTS_INVALID");
}
const maxBytes = Number(process.env.GFS_MAX_DOWNLOAD_BYTES || 64 * 1024 * 1024);
if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || (collectionMode === "48H" && maxBytes > 15 * 1024 * 1024)) {
  throw new Error("GFS_MAX_DOWNLOAD_BYTES_INVALID");
}
const budget = new DownloadBudget({
  maxRequests,
  maxBytes
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
  const product = await fetchText(NOMADS_PRODUCT_DIRECTORY, budget);
  const dates = parseRunDates(product);
  if (!dates.length) throw new Error("GFS_PRODUCT_DIRECTORY_EMPTY");
  const candidateDates = dates.slice(-2);
  const cycles = {};
  for (const runDate of candidateDates) {
    const cyclesHtml = await fetchText(new URL(`gfs.${runDate}/`, NOMADS_PRODUCT_DIRECTORY), budget);
    cycles[runDate] = parseCycles(cyclesHtml);
  }
  const candidates = listPublishedRuns(candidateDates, cycles).reverse();
  for (const run of candidates) {
    if (budget.requestsUsed >= maxRequests - requestedHours.length) break;
    if (await verifyRunComplete(run, Math.max(...requestedHours), budget)) return run;
  }
  throw new Error("GFS_NO_COMPLETE_48H_RUN_WITHIN_BUDGET");
}

function runKey(run) {
  return run.modelRunAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

async function assertNoSuccessfulArtifact(run) {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "")) {
    throw new Error("GFS_GITHUB_DEDUP_CONFIGURATION_MISSING");
  }
  const artifactName = `gfs-48h-${runKey(run)}`;
  const api = new URL(`https://api.github.com/repos/${repository}/actions/artifacts`);
  api.searchParams.set("name", artifactName);
  api.searchParams.set("per_page", "10");
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const response = await fetch(api, { redirect: "manual", headers });
  if (response.status !== 200) throw new Error(`GFS_GITHUB_ARTIFACT_LOOKUP_HTTP_${response.status}`);
  const result = await response.json();
  for (const artifact of result.artifacts || []) {
    if (artifact.name !== artifactName || artifact.expired || !Number.isSafeInteger(artifact.workflow_run?.id)) continue;
    const runResponse = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${artifact.workflow_run.id}`, {
      redirect: "manual", headers
    });
    if (runResponse.status !== 200) throw new Error(`GFS_GITHUB_RUN_LOOKUP_HTTP_${runResponse.status}`);
    const previousRun = await runResponse.json();
    const trustedWorkflow = new Set([
      ".github/workflows/collect-gfs.yml",
      ".github/workflows/collect-gfs-automatic.yml"
    ]).has(String(previousRun.path || "").split("@")[0]);
    const trustedEvent = new Set(["workflow_dispatch", "schedule"]).has(previousRun.event);
    if (previousRun.repository?.full_name === repository && previousRun.head_branch === "main"
        && trustedWorkflow && trustedEvent) {
      throw new Error("GFS_RUN_ALREADY_COLLECTED");
    }
  }
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
    "--expected-forecast-hours", requestedHours.join(","),
    "--output", output
  ]);
  return JSON.parse(await readFile(output, "utf8"));
}

const attemptStartedAt = new Date().toISOString();
let discoveredRun;

function failureCode(error) {
  const code = String(error?.message || "GFS_COLLECTION_FAILED").split(":", 1)[0];
  return /^[A-Z0-9_]{3,120}$/.test(code) ? code : "GFS_COLLECTION_FAILED";
}

async function preserveEvidence({ status, result = null, error = null }) {
  const evidence = {
    schemaVersion: "weather.gfs.collection-evidence.v2",
    status,
    attemptStartedAt,
    attemptCompletedAt: new Date().toISOString(),
    eventName: process.env.GITHUB_EVENT_NAME || "LOCAL",
    workflowRunId: process.env.GITHUB_RUN_ID || null,
    workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    collectionMode,
    forecastHours: requestedHours,
    modelRunAt: discoveredRun?.modelRunAt || null,
    result,
    budget: budget.snapshot(),
    failureCode: error ? failureCode(error) : null
  };
  await mkdir(storeRoot, { recursive: true });
  await writeFile(resolve(storeRoot, "collection-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

try {
  const result = await runCollectorWorkflow({
    store,
    discoverRun: async () => {
      discoveredRun = await discoverRun();
      await assertNoSuccessfulArtifact(discoveredRun);
      return discoveredRun;
    },
    collectDataset
  });
  await preserveEvidence({ status: "SUCCESS", result });
  if (process.env.GITHUB_OUTPUT && discoveredRun) {
    await appendFile(process.env.GITHUB_OUTPUT, `model_run_key=${runKey(discoveredRun)}\n`, "utf8");
  }
} catch (error) {
  const evidence = await preserveEvidence({ status: "FAILED", error });
  throw new Error(evidence.failureCode);
}
