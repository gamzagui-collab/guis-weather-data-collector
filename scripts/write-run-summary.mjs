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
const evidence = await safe("collection-evidence.json");
const lines = [
  "## GFS collector",
  `- attempt status: ${evidence?.status || "NO_EVIDENCE"}`,
  `- pipeline status: ${process.env.GFS_PIPELINE_STATUS || "UNAVAILABLE"}`,
  `- attempt started: ${evidence?.attemptStartedAt || "UNAVAILABLE"}`,
  `- attempt completed: ${evidence?.attemptCompletedAt || "UNAVAILABLE"}`,
  `- collection status: ${status?.status || "NO_STATUS"}`,
  `- run: ${latest?.modelRunAt || evidence?.modelRunAt || status?.attemptedRunId || "UNAVAILABLE"}`,
  `- latest valid time: ${latest?.latestValidAt || "UNAVAILABLE"}`,
  `- coverage: ${latest?.coverage?.label || "UNAVAILABLE"}`,
  `- NOAA requests: ${evidence?.budget?.requestsUsed ?? "UNAVAILABLE"}`,
  `- NOAA bytes: ${evidence?.budget?.bytesUsed ?? "UNAVAILABLE"}`,
  `- failure code: ${evidence?.failureCode || status?.failureCode || "none"}`,
  ""
];
await appendFile(summary, lines.join("\n"), "utf8");
