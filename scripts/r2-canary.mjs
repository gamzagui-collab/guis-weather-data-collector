import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, parseJson, sha256 } from "../src/contracts.mjs";
import { r2Args, runAws, verifiedR2Environment } from "../src/r2-cli.mjs";

if (!process.argv.includes("--execute")) throw new Error("R2_CANARY_EXECUTION_FLAG_REQUIRED");
verifiedR2Environment();
const root = await mkdtemp(join(tmpdir(), "gfs-r2-canary-"));
const runId = String(process.env.GITHUB_RUN_ID || Date.now());
if (!/^\d+$/.test(runId)) throw new Error("R2_CANARY_RUN_ID_INVALID");
const key = `test/preflight/${runId}/canary.json`;
const source = join(root, "source.json");
const downloaded = join(root, "downloaded.json");
const body = Buffer.from(canonicalJson({ schemaVersion: "weather.gfs.r2-canary.v1", runId, nonce: randomUUID() }), "utf8");
const digest = sha256(body);

try {
  await writeFile(source, body);
  await runAws(r2Args("put-object", ["--key", key, "--body", source, "--content-type", "application/json", "--metadata", `sha256=${digest}`]));
  const head = parseJson(Buffer.from((await runAws(r2Args("head-object", ["--key", key]))).stdout));
  if (Number(head.ContentLength) !== body.byteLength || head.Metadata?.sha256 !== digest) throw new Error("R2_CANARY_HEAD_MISMATCH");
  await runAws(r2Args("get-object", ["--key", key, downloaded]));
  const received = await readFile(downloaded);
  if (sha256(received) !== digest || !received.equals(body)) throw new Error("R2_CANARY_GET_MISMATCH");
  await runAws(r2Args("delete-object", ["--key", key]));
  const absent = await runAws(r2Args("head-object", ["--key", key]), { allowFailure: true });
  if (absent.code === 0 || absent.failureKind !== "NOT_FOUND") throw new Error("R2_CANARY_DELETE_NOT_CONFIRMED");
  process.stdout.write(`${JSON.stringify({ status: "PASS", key, bytes: body.byteLength, sha256: digest, deleted: true })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
