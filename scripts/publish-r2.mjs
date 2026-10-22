import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalObjectStore } from "../src/object-store.mjs";
import { parseJson, sha256 } from "../src/contracts.mjs";
import { LATEST_KEY, STATUS_KEY, readLatestPublication } from "../src/publisher.mjs";
import { r2Args, runAws, verifiedR2Environment } from "../src/r2-cli.mjs";

if (!process.argv.includes("--execute")) throw new Error("R2_REMOTE_EXECUTION_FLAG_REQUIRED");
const index = process.argv.indexOf("--verified-local-store");
if (index < 0 || !process.argv[index + 1]) throw new Error("R2_LOCAL_STORE_REQUIRED");
const localRoot = resolve(process.argv[index + 1]);
verifiedR2Environment();
const store = new LocalObjectStore(localRoot);
const { latest, manifest } = await readLatestPublication(store);

const descriptors = [manifest.grid, ...manifest.forecasts, latest.manifest];
for (const descriptor of descriptors) {
  const body = await store.get(descriptor.key);
  if (body.byteLength !== descriptor.bytes || sha256(body) !== descriptor.sha256) throw new Error("R2_LOCAL_INTEGRITY_FAILED");
}
const status = await store.tryGet(STATUS_KEY);
const ordered = [...descriptors.map((item) => item.key), ...(status ? [STATUS_KEY] : []), LATEST_KEY];
const temporary = await mkdtemp(join(tmpdir(), "gfs-r2-publish-"));

async function remoteHead(key) {
  const result = await runAws(r2Args("head-object", ["--key", key]), { allowFailure: true });
  if (result.code !== 0 && result.failureKind === "NOT_FOUND") return null;
  if (result.code !== 0) throw new Error("R2_REMOTE_HEAD_FAILED");
  return parseJson(Buffer.from(result.stdout));
}

async function remoteJson(key, name) {
  const target = join(temporary, name);
  const result = await runAws(r2Args("get-object", ["--key", key, target]), { allowFailure: true });
  if (result.code !== 0 && result.failureKind === "NOT_FOUND") return null;
  if (result.code !== 0) throw new Error("R2_EXISTING_LATEST_READ_FAILED");
  return parseJson(await readFile(target));
}

try {
  const current = await remoteJson(LATEST_KEY, "current-latest.json");
  if (current && Date.parse(current.modelRunAt) > Date.parse(latest.modelRunAt)) throw new Error("R2_LATEST_REGRESSION_BLOCKED");
  let uploadedCount = 0;
  let reusedCount = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const key = ordered[index];
    const localPath = store.path(key);
    const body = await readFile(localPath);
    const digest = sha256(body);
    let remote = await remoteHead(key);
    const exactRemote = remote && Number(remote.ContentLength) === body.byteLength && remote.Metadata?.sha256 === digest;
    if (exactRemote) {
      reusedCount += 1;
    } else {
      if (remote && key.startsWith("runs/")) throw new Error("R2_IMMUTABLE_OBJECT_CONFLICT");
      await runAws(r2Args("put-object", ["--key", key, "--body", localPath,
        "--content-type", "application/json", "--metadata", `sha256=${digest}`]));
      uploadedCount += 1;
      remote = await remoteHead(key);
    }
    if (Number(remote.ContentLength) !== body.byteLength || remote.Metadata?.sha256 !== digest) throw new Error("R2_REMOTE_HEAD_INTEGRITY_FAILED");
    const downloaded = join(temporary, `object-${index}.json`);
    await runAws(r2Args("get-object", ["--key", key, downloaded]));
    const remoteBody = await readFile(downloaded);
    if (remoteBody.byteLength !== body.byteLength || sha256(remoteBody) !== digest) throw new Error("R2_REMOTE_BODY_INTEGRITY_FAILED");
    parseJson(remoteBody, "R2_REMOTE_JSON_INVALID");
  }
  process.stdout.write(`${JSON.stringify({ status: "PUBLISHED", runId: latest.runId, objectCount: ordered.length,
    uploadedCount, reusedCount, manifestSha256: latest.manifest.sha256 })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
