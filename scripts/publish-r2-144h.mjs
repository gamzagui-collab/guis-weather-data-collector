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
import { runPublishStages } from "../src/bounded-publisher.mjs";

const PUBLISH_CONCURRENCY = 8;

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
const v5ManifestKey = latest.indexes.v5.manifest.key;
const v5PublicationKey = latest.indexes.v5.publication.key;
const sourceData = [manifest.grid.key, ...manifest.forecasts.map((item) => item.key)];
const indexData = [...tileDescriptors.map((item) => item.key),
  ...publication.objects.filter((item) => item.key !== v5ManifestKey).map((item) => item.key)];
const stages = [
  { name: "source-data", items: sourceData },
  { name: "source-manifest", items: [latest.manifest.key], serial: true },
  { name: "index-data", items: indexData },
  { name: "index-manifests", items: [indexKey, v5ManifestKey] },
  { name: "v5-publication", items: [v5PublicationKey], serial: true },
  ...(status ? [{ name: "status", items: [STATUS_144H_KEY], serial: true }] : []),
  { name: "latest", items: [LATEST_144H_KEY], serial: true }
];
const ordered = stages.flatMap((stage) => stage.items);
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
  const body = await readFile(target);
  return { value: parseJson(body), sha256: sha256(body) };
}

try {
  const currentObject = await remoteJson(LATEST_144H_KEY, "current-144h-latest.json");
  if (currentObject && Date.parse(currentObject.value.modelRunAt) > Date.parse(latest.modelRunAt)) {
    throw new Error("R2_144H_LATEST_REGRESSION_BLOCKED");
  }
  let totalBytes = 0;
  const descriptorByKey = new Map(descriptors.map((item) => [item.key, item]));
  const objectIndexes = new Map(ordered.map((key, index) => [key, index]));
  for (const key of ordered) totalBytes += (await store.get(key)).byteLength;
  const targetLatestSha256 = sha256(await store.get(LATEST_144H_KEY));
  const progress = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const publishResult = await runPublishStages(stages, {
    concurrency: PUBLISH_CONCURRENCY,
    onProgress: progress,
    beforeStage: async (stage) => {
      if (stage.name !== "latest") return;
      const beforeSwap = await remoteJson(LATEST_144H_KEY, "before-swap-144h-latest.json");
      if (beforeSwap && Date.parse(beforeSwap.value.modelRunAt) > Date.parse(latest.modelRunAt)) {
        throw new Error("R2_144H_LATEST_REGRESSION_BLOCKED");
      }
      if (beforeSwap && Date.parse(beforeSwap.value.modelRunAt) === Date.parse(latest.modelRunAt)
        && beforeSwap.sha256 !== targetLatestSha256) throw new Error("R2_144H_LATEST_CONFLICT");
      if (currentObject && beforeSwap && Date.parse(beforeSwap.value.modelRunAt) < Date.parse(latest.modelRunAt)
        && beforeSwap.sha256 !== currentObject.sha256) throw new Error("R2_144H_LATEST_RACE");
    },
    publishObject: async (key) => {
      let operation = "read-local";
      try {
        const localPath = store.path(key);
        const body = await readFile(localPath);
        const digest = sha256(body);
        operation = "head";
        let remote = await remoteHead(key);
        const descriptor = descriptorByKey.get(key);
        const metadataMatches = Object.entries(descriptor?.customMetadata || {})
          .every(([name, expected]) => String(remote?.Metadata?.[name]) === String(expected));
        const exactRemote = remote && Number(remote.ContentLength) === body.byteLength
          && remote.Metadata?.sha256 === digest && metadataMatches;
        let outcome = "reused";
        if (!exactRemote) {
          if (remote && key.startsWith(`${GFS_144H_NAMESPACE}/runs/`)) {
            throw new Error("R2_144H_IMMUTABLE_OBJECT_CONFLICT");
          }
          const contentType = descriptor?.contentType || "application/json";
          const metadata = { sha256: digest, ...(descriptor?.customMetadata || {}) };
          operation = "put";
          await runAws(r2Args("put-object", ["--key", key, "--body", localPath,
            "--content-type", contentType, "--metadata", JSON.stringify(metadata)]));
          outcome = "uploaded";
          operation = "verify-head";
          remote = await remoteHead(key);
        }
        if (Number(remote.ContentLength) !== body.byteLength || remote.Metadata?.sha256 !== digest) {
          throw new Error("R2_144H_REMOTE_HEAD_INTEGRITY_FAILED");
        }
        operation = "get";
        const downloaded = join(temporary, `object-${objectIndexes.get(key)}.bin`);
        await runAws(r2Args("get-object", ["--key", key, downloaded]));
        const remoteBody = await readFile(downloaded);
        operation = "verify-body";
        if (remoteBody.byteLength !== body.byteLength || sha256(remoteBody) !== digest) {
          throw new Error("R2_144H_REMOTE_BODY_INTEGRITY_FAILED");
        }
        if ((descriptorByKey.get(key)?.contentType || "application/json") === "application/json") {
          parseJson(remoteBody, "R2_144H_REMOTE_JSON_INVALID");
        }
        return outcome;
      } catch (error) {
        error.publishOperation = operation;
        throw error;
      }
    }
  });
  const latestBody = await store.get(LATEST_144H_KEY);
  const result = {
    status: "PUBLISHED_COMPLETE_144H",
    namespace: GFS_144H_NAMESPACE,
    runId: latest.runId,
    modelRunAt: latest.modelRunAt,
    latestValidAt: latest.latestValidAt,
    objectCount: ordered.length,
    uploadedCount: publishResult.uploaded,
    reusedCount: publishResult.reused,
    elapsedMs: publishResult.elapsedMs,
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
