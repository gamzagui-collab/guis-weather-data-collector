import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.env.GFS_LOCAL_STORE || ".mock-r2");
const summary = process.env.GITHUB_STEP_SUMMARY;
if (!summary) process.exit(0);
const safe = async (name) => {
  try { return JSON.parse(await readFile(resolve(root, name), "utf8")); }
  catch { return null; }
};
const latest = await safe("latest.json");
const status = await safe("status/collector.json");
const evidence = await safe("pilot-evidence.json");
const lines = [
  "## GFS collector",
  `- status: ${status?.status || "NO_STATUS"}`,
  `- run: ${latest?.modelRunAt || status?.attemptedRunId || "UNAVAILABLE"}`,
  `- latest valid time: ${latest?.latestValidAt || "UNAVAILABLE"}`,
  `- NOAA requests: ${evidence?.budget?.requestsUsed ?? "UNAVAILABLE"}`,
  `- NOAA bytes: ${evidence?.budget?.bytesUsed ?? "UNAVAILABLE"}`,
  `- failure code: ${status?.failureCode || "none"}`,
  ""
];
await appendFile(summary, lines.join("\n"), "utf8");
