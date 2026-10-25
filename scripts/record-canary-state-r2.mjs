import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANARY_144H_STATUS_KEY, mergeCanaryState } from "../src/canary-state.mjs";
import { parseJson, sha256 } from "../src/contracts.mjs";
import { r2Args, runAws, verifiedR2Environment } from "../src/r2-cli.mjs";

if (!process.argv.includes("--execute")) throw new Error("R2_144H_CANARY_RECORD_EXECUTION_FLAG_REQUIRED");
verifiedR2Environment();
const temporary = await mkdtemp(join(tmpdir(), "gfs-r2-144h-canary-"));

async function currentState() {
  const target = join(temporary, "current.json");
  const result = await runAws(r2Args("get-object", ["--key", CANARY_144H_STATUS_KEY, target]), { allowFailure: true });
  if (result.code !== 0 && result.failureKind === "NOT_FOUND") return null;
  if (result.code !== 0) throw new Error("R2_144H_CANARY_STATE_READ_FAILED");
  return parseJson(await readFile(target), "R2_144H_CANARY_STATE_JSON_INVALID");
}

try {
  const recordedAt = new Date().toISOString();
  const state = mergeCanaryState(await currentState(), {
    startsAt: process.env.GFS_144H_CANARY_START_AT,
    expiresAt: process.env.GFS_144H_CANARY_EXPIRES_AT,
    baselineModelRunAt: process.env.GFS_144H_CANARY_BASELINE_MODEL_RUN_AT,
    publicationLimit: process.env.GFS_144H_CANARY_PUBLICATION_LIMIT,
    requestsUsed: process.env.GFS_CANARY_REQUESTS_USED || "0",
    bytesUsed: process.env.GFS_CANARY_BYTES_USED || "0",
    workflowRunId: `${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT || "1"}`,
    eventName: process.env.GITHUB_EVENT_NAME,
    attemptedAt: process.env.GFS_CANARY_ATTEMPTED_AT || recordedAt,
    outcome: process.env.GFS_CANARY_COLLECTION_OUTCOME || "UNKNOWN",
    publishResult: process.env.GFS_CANARY_PUBLISH_RESULT || "skipped",
    publishedModelRunAt: process.env.GFS_CANARY_PUBLISHED_MODEL_RUN_AT || null,
    publishedRunId: process.env.GFS_CANARY_PUBLISHED_RUN_ID || null,
    recordedAt
  });
  const body = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  const local = join(temporary, "next.json");
  await writeFile(local, body);
  const digest = sha256(body);
  await runAws(r2Args("put-object", ["--key", CANARY_144H_STATUS_KEY, "--body", local,
    "--content-type", "application/json", "--metadata", `sha256=${digest}`]));
  const verify = await runAws(r2Args("head-object", ["--key", CANARY_144H_STATUS_KEY]));
  const head = parseJson(Buffer.from(verify.stdout), "R2_144H_CANARY_STATE_HEAD_INVALID");
  if (Number(head.ContentLength) !== body.byteLength || head.Metadata?.sha256 !== digest) {
    throw new Error("R2_144H_CANARY_STATE_WRITE_VERIFICATION_FAILED");
  }
  process.stdout.write(`${JSON.stringify({ status: "CANARY_STATE_RECORDED", publicationCount: state.successfulPublications.length,
    attemptCount: state.attempts.length, totalNoaaRequests: state.totalNoaaRequests, totalNoaaBytes: state.totalNoaaBytes })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
