import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.env.GFS_LOCAL_STORE || ".mock-r2");
const target = resolve(root, "operation-status.json");
let evidence = null;
try { evidence = JSON.parse(await readFile(resolve(root, "collection-evidence.json"), "utf8")); }
catch { /* A setup/test failure can precede collection evidence. */ }

const value = {
  schemaVersion: "weather.gfs.operation-status.v1",
  recordedAt: new Date().toISOString(),
  repository: process.env.GITHUB_REPOSITORY || null,
  ref: process.env.GITHUB_REF_NAME || null,
  commit: process.env.GITHUB_SHA || null,
  workflowRunId: process.env.GITHUB_RUN_ID || null,
  workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
  eventName: process.env.GITHUB_EVENT_NAME || null,
  pipelineStatus: process.env.GFS_PIPELINE_STATUS || "unknown",
  collectionStatus: evidence?.status || "NOT_STARTED",
  modelRunAt: evidence?.modelRunAt || null,
  noaaRequests: evidence?.budget?.requestsUsed ?? 0,
  noaaBytes: evidence?.budget?.bytesUsed ?? 0,
  failureCode: evidence?.failureCode || (process.env.GFS_PIPELINE_STATUS === "success" ? null : "PIPELINE_STAGE_FAILED")
};
await mkdir(root, { recursive: true });
await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ status: "OPERATION_STATUS_RECORDED", collectionStatus: value.collectionStatus,
  failureCode: value.failureCode })}\n`);
