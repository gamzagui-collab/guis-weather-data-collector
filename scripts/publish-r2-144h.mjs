import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalObjectStore } from "../src/object-store.mjs";
import { parseJson, sha256 } from "../src/contracts.mjs";
import { GFS_144H_NAMESPACE } from "../src/horizon-144.mjs";
import { indexV2ManifestKey, validateIndexV2Manifest } from "../src/indexes-v2.mjs";
import { validateIndexV5Publication } from "../src/indexes-v5.mjs";
import { LATEST_144H_KEY, STATUS_144H_KEY, readLatestOperationalPublication144 } from "../src/publisher-144.mjs";
import { r2Args, runAws, verifiedR2Environment } from "../src/r2-cli.mjs";

if (!process.argv.includes("--execute")) throw new Error("R2_144H_REMOTE_EXECUTION_FLAG_REQUIRED");
const sourceIndex = process.argv.indexOf("--verified-local-store");
if (sourceIndex < 0 || !process.argv[sourceIndex + 1]) throw new Error("R2_144H_LOCAL_STORE_REQUIRED");
const localRoot = resolve(process.argv[sourceIndex + 1]);
verifiedR2Environment();
const store = new LocalObjectStore(localRoot);
const { latest, manifest, index, publication } = await readLatestOperationalPublication144(store);
validateIndexV2Manifest(index, { runId: latest.runId, sourceManifest: latest.manifest });
validateIndexV5Publication(publication, {
  runId: latest.runId, sourceManifest: latest.manifest, sourceGrid: manifest.grid,
  indexManifest: latest.indexes.v5.manifest
});
const indexKey = indexV2ManifestKey(latest.runId);
const indexBody = await store.get(indexKey);
const tileDescriptors = index.windows.flatMap((window) => window.tiles);
const descriptors = [manifest.grid, ...manifest.forecasts, ...tileDescriptors,
  { key: indexKey, bytes: indexBody.byteLength, sha256: sha256(indexBody) }, latest.manifest,
  ...publication.objects, latest.indexes.v5.publication];
for (const descriptor of descriptors) {
  if (!descriptor.key.startsWith(`${GFS_144H_NAMESPACE}/`)) throw new Error("R2_144H_NAMESPACE_ESCAPE");
  const body = await store.get(descriptor.key);
  if (body.byteLength !== descriptor.bytes || sha256(body) !== descriptor.sha256) throw new Error("R2_144H_LOCAL_INTEGRITY_FAILED");
}
const status = await store.tryGet(STATUS_144H_KEY);
const ordered = [...descriptors.map((item) => item.key), ...(status ? [STATUS_144H_KEY] : []), LATEST_144H_KEY];
if (new Set(ordered).size !== ordered.length || ordered.some((key) => !key.startsWith(`${GFS_144H_NAMESPACE}/`))) {
  throw new Error("R2_144H_PUBLICATION_SET_INVALID");
}
const temporary = await mkdtemp(join(tmpdir(), "gfs-r2-144h-publish-"));

async function remoteHead(key) {
  const result = await runAws(r2Args("head-object", ["--key", key]), { allowFailure: true });
  if (result.code !== 0 && result.failureKind === "NOT_FOUND") return null;
  if (result.code !== 0) throw new Error("R2_144H_REMOTE_HEAD_FAILED");
  return parseJson(Buffer.from(result.stdout));
}

async function remoteJson(key, name) {
  const target = join(temporary, name);
  const result = await runAws(r2Args("get-object", ["--key", key, target]), { allowFailure: true });
  if (result.code !== 0 && result.failureKind === "NOT_FOUND") return null;
  if (result.code !== 0) throw new Error("R2_144H_EXISTING_LATEST_READ_FAILED");
  return parseJson(await readFile(target));
}

try {
  const current = await remoteJson(LATEST_144H_KEY, "current-144h-latest.json");
  if (current && Date.parse(current.modelRunAt) > Date.parse(latest.modelRunAt)) throw new Error("R2_144H_LATEST_REGRESSION_BLOCKED");
  let uploadedCount = 0;
  let reusedCount = 0;
  let totalBytes = 0;
  const descriptorByKey = new Map(descriptors.map((item) => [item.key, item]));
  for (let objectIndex = 0; objectIndex < ordered.length; objectIndex += 1) {
    const key = ordered[objectIndex];
    const localPath = store.path(key);
    const body = await readFile(localPath);
    const digest = sha256(body);
    totalBytes += body.byteLength;
    let remote = await remoteHead(key);
    const exactRemote = remote && Number(remote.ContentLength) === body.byteLength && remote.Metadata?.sha256 === digest;
    if (exactRemote) {
      reusedCount += 1;
    } else {
      if (remote && key.startsWith(`${GFS_144H_NAMESPACE}/runs/`)) throw new Error("R2_144H_IMMUTABLE_OBJECT_CONFLICT");
      const descriptor = descriptorByKey.get(key);
      const contentType = descriptor?.contentType || "application/json";
      const metadata = { sha256: digest, ...(descriptor?.customMetadata || {}) };
      await runAws(r2Args("put-object", ["--key", key, "--body", localPath,
        "--content-type", contentType, "--metadata", JSON.stringify(metadata)]));
      uploadedCount += 1;
      remote = await remoteHead(key);
    }
    if (Number(remote.ContentLength) !== body.byteLength || remote.Metadata?.sha256 !== digest) {
      throw new Error("R2_144H_REMOTE_HEAD_INTEGRITY_FAILED");
    }
    const downloaded = join(temporary, `object-${objectIndex}.json`);
    await runAws(r2Args("get-object", ["--key", key, downloaded]));
    const remoteBody = await readFile(downloaded);
    if (remoteBody.byteLength !== body.byteLength || sha256(remoteBody) !== digest) {
      throw new Error("R2_144H_REMOTE_BODY_INTEGRITY_FAILED");
    }
    if ((descriptorByKey.get(key)?.contentType || "application/json") === "application/json") {
      parseJson(remoteBody, "R2_144H_REMOTE_JSON_INVALID");
    }
  }
  const latestBody = await store.get(LATEST_144H_KEY);
  const result = {
    status: "PUBLISHED_COMPLETE_144H",
    namespace: GFS_144H_NAMESPACE,
    runId: latest.runId,
    modelRunAt: latest.modelRunAt,
    latestValidAt: latest.latestValidAt,
    objectCount: ordered.length,
    uploadedCount,
    reusedCount,
    totalBytes,
    manifestSha256: latest.manifest.sha256,
    indexManifestSha256: sha256(indexBody),
    v5IndexManifestSha256: latest.indexes.v5.manifest.sha256,
    latestSha256: sha256(latestBody)
  };
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT,
      `run_id=${result.runId}\nmodel_run_at=${result.modelRunAt}\nlatest_valid_at=${result.latestValidAt}\n`
      + `object_count=${result.objectCount}\nuploaded_count=${result.uploadedCount}\nreused_count=${result.reusedCount}\n`
      + `total_bytes=${result.totalBytes}\nmanifest_sha256=${result.manifestSha256}\n`
      + `index_manifest_sha256=${result.indexManifestSha256}\n`
      + `v5_index_manifest_sha256=${result.v5IndexManifestSha256}\nlatest_sha256=${result.latestSha256}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
