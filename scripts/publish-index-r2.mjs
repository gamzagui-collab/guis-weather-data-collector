import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalObjectStore } from "../src/object-store.mjs";
import { parseJson, sha256 } from "../src/contracts.mjs";
import { indexManifestKey, validateIndexManifest, validateIndexTile } from "../src/indexes.mjs";
import { LATEST_KEY, readLatestPublication } from "../src/publisher.mjs";
import { r2Args, runAws, verifiedR2Environment } from "../src/r2-cli.mjs";

if (!process.argv.includes("--execute")) throw new Error("R2_REMOTE_EXECUTION_FLAG_REQUIRED");
const sourceIndex = process.argv.indexOf("--source-store");
const indexIndex = process.argv.indexOf("--index-store");
if (sourceIndex < 0 || !process.argv[sourceIndex + 1] || indexIndex < 0 || !process.argv[indexIndex + 1]) {
  throw new Error("GFS_INDEX_STORE_ARGUMENTS_REQUIRED");
}
verifiedR2Environment();
const source = new LocalObjectStore(resolve(process.argv[sourceIndex + 1]));
const indexes = new LocalObjectStore(resolve(process.argv[indexIndex + 1]));
const { latest, manifest } = await readLatestPublication(source);
const manifestKey = indexManifestKey(latest.runId);
const indexBody = await indexes.get(manifestKey);
const indexManifest = parseJson(indexBody);
validateIndexManifest(indexManifest, { runId: latest.runId, sourceManifest: latest.manifest });
const temporary = await mkdtemp(join(tmpdir(), "gfs-index-r2-"));

async function remoteHead(key) {
  const result = await runAws(r2Args("head-object", ["--key", key]), { allowFailure: true });
  if (result.code !== 0 && result.failureKind === "NOT_FOUND") return null;
  if (result.code !== 0) throw new Error("R2_REMOTE_HEAD_FAILED");
  return parseJson(Buffer.from(result.stdout));
}

async function remoteBody(key, name) {
  const target = join(temporary, name);
  const result = await runAws(r2Args("get-object", ["--key", key, target]), { allowFailure: true });
  if (result.code !== 0 && result.failureKind === "NOT_FOUND") return null;
  if (result.code !== 0) throw new Error("R2_REMOTE_READ_FAILED");
  return await readFile(target);
}

try {
  const remoteLatestBody = await remoteBody(LATEST_KEY, "latest.json");
  if (!remoteLatestBody) throw new Error("R2_LATEST_NOT_FOUND");
  const remoteLatest = parseJson(remoteLatestBody);
  if (remoteLatest.runId !== latest.runId || remoteLatest.manifest?.sha256 !== latest.manifest.sha256) {
    throw new Error("R2_INDEX_SOURCE_LATEST_MISMATCH");
  }
  const remoteSourceManifest = await remoteBody(latest.manifest.key, "source-manifest.json");
  if (!remoteSourceManifest || remoteSourceManifest.byteLength !== latest.manifest.bytes
    || sha256(remoteSourceManifest) !== latest.manifest.sha256) throw new Error("R2_INDEX_SOURCE_MANIFEST_MISMATCH");
  let uploadedCount = 0;
  let reusedCount = 0;
  const ordered = [...indexManifest.tiles.map((item) => item.key), manifestKey];
  for (let position = 0; position < ordered.length; position += 1) {
    const key = ordered[position];
    const body = await indexes.get(key);
    const digest = sha256(body);
    let remote = await remoteHead(key);
    const exact = remote && Number(remote.ContentLength) === body.byteLength && remote.Metadata?.sha256 === digest;
    if (exact) reusedCount += 1;
    else {
      if (remote) throw new Error("R2_IMMUTABLE_INDEX_CONFLICT");
      await runAws(r2Args("put-object", ["--key", key, "--body", indexes.path(key),
        "--content-type", "application/json", "--metadata", `sha256=${digest}`]));
      uploadedCount += 1;
      remote = await remoteHead(key);
    }
    if (Number(remote.ContentLength) !== body.byteLength || remote.Metadata?.sha256 !== digest) {
      throw new Error("R2_INDEX_HEAD_INTEGRITY_FAILED");
    }
    const downloaded = await remoteBody(key, `object-${position}.json`);
    if (!downloaded || downloaded.byteLength !== body.byteLength || sha256(downloaded) !== digest) {
      throw new Error("R2_INDEX_BODY_INTEGRITY_FAILED");
    }
    const value = parseJson(downloaded);
    if (key === manifestKey) validateIndexManifest(value, { runId: latest.runId, sourceManifest: latest.manifest });
    else {
      const descriptor = indexManifest.tiles.find((item) => item.key === key);
      validateIndexTile(value, { runId: latest.runId, sourceManifest: latest.manifest,
        descriptor, contractCount: manifest.forecasts.length });
    }
  }
  process.stdout.write(`${JSON.stringify({ status: "INDEX_PUBLISHED", runId: latest.runId,
    objectCount: ordered.length, uploadedCount, reusedCount, manifestSha256: sha256(indexBody) })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
