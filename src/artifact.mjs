import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { canonicalJson, parseJson, sha256 } from "./contracts.mjs";
import { LocalObjectStore } from "./object-store.mjs";
import { LATEST_KEY, STATUS_KEY, readLatestPublication } from "./publisher.mjs";
import { indexManifestKey, validateIndexManifest, validateIndexTile } from "./indexes.mjs";

export const ARTIFACT_SCHEMA = "weather.gfs.collector-artifact.v1";
export const ARTIFACT_METADATA = "metadata.json";
export const ARTIFACT_PAYLOAD = "payload";

function exactIdentity(value, pattern, code) {
  if (!pattern.test(String(value || ""))) throw new Error(code);
  return String(value);
}

function artifactPath(root, relative) {
  const base = resolve(root);
  const target = resolve(base, ...String(relative).replaceAll("\\", "/").split("/"));
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error("GFS_ARTIFACT_PATH_ESCAPE");
  return target;
}

export async function createPublicationArtifact({ storeRoot, artifactRoot, provenance }) {
  const repository = exactIdentity(provenance?.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "GFS_ARTIFACT_REPOSITORY_INVALID");
  const ref = exactIdentity(provenance?.ref, /^main$/, "GFS_ARTIFACT_REF_INVALID");
  const commit = exactIdentity(provenance?.commit, /^[a-f0-9]{40}$/, "GFS_ARTIFACT_COMMIT_INVALID");
  const workflowRunId = exactIdentity(provenance?.workflowRunId, /^\d+$/, "GFS_ARTIFACT_RUN_ID_INVALID");
  const source = new LocalObjectStore(storeRoot);
  const { latest, manifest } = await readLatestPublication(source);
  const statusBody = await source.get(STATUS_KEY);
  const status = parseJson(statusBody, "GFS_ARTIFACT_STATUS_INVALID");
  if (status.status !== "SUCCESS" || status.attemptedRunId !== latest.runId) throw new Error("GFS_ARTIFACT_COLLECTION_INCOMPLETE");
  const indexKey = indexManifestKey(latest.runId);
  const indexBody = await source.tryGet(indexKey);
  let indexManifest = null;
  if (indexBody) {
    indexManifest = parseJson(indexBody, "GFS_ARTIFACT_INDEX_INVALID");
    validateIndexManifest(indexManifest, { runId: latest.runId, sourceManifest: latest.manifest });
    for (const item of indexManifest.tiles) {
      const tileBody = await source.get(item.key);
      if (tileBody.byteLength !== item.bytes || sha256(tileBody) !== item.sha256) throw new Error("GFS_ARTIFACT_INDEX_INTEGRITY_FAILED");
      validateIndexTile(parseJson(tileBody), { runId: latest.runId, sourceManifest: latest.manifest,
        descriptor: item, contractCount: manifest.forecasts.length });
    }
  }
  const keys = [manifest.grid.key, ...manifest.forecasts.map((item) => item.key),
    ...(indexManifest ? [...indexManifest.tiles.map((item) => item.key), indexKey] : []),
    latest.manifest.key, STATUS_KEY, LATEST_KEY];
  const destination = new LocalObjectStore(artifactPath(artifactRoot, ARTIFACT_PAYLOAD));
  await rm(resolve(artifactRoot), { recursive: true, force: true });
  const objects = [];
  for (const key of keys) {
    const body = await source.get(key);
    const descriptor = { key, bytes: body.byteLength, sha256: sha256(body) };
    await destination.put(key, body);
    objects.push(descriptor);
  }
  const metadata = {
    schemaVersion: ARTIFACT_SCHEMA,
    repository,
    ref,
    commit,
    workflowRunId,
    runId: latest.runId,
    modelRunAt: latest.modelRunAt,
    manifest: latest.manifest,
    objectCount: objects.length,
    objects
  };
  await mkdir(resolve(artifactRoot), { recursive: true });
  await writeFile(artifactPath(artifactRoot, ARTIFACT_METADATA), canonicalJson(metadata), "utf8");
  return metadata;
}

export async function verifyPublicationArtifact({ artifactRoot, expected }) {
  const metadata = parseJson(await readFile(artifactPath(artifactRoot, ARTIFACT_METADATA)), "GFS_ARTIFACT_METADATA_INVALID");
  if (metadata.schemaVersion !== ARTIFACT_SCHEMA) throw new Error("GFS_ARTIFACT_SCHEMA_INVALID");
  for (const [field, value] of Object.entries(expected || {})) {
    if (String(metadata[field]) !== String(value)) throw new Error(`GFS_ARTIFACT_${field.toUpperCase()}_MISMATCH`);
  }
  if (!Array.isArray(metadata.objects) || metadata.objectCount !== metadata.objects.length || metadata.objects.length < 5) {
    throw new Error("GFS_ARTIFACT_OBJECTS_INVALID");
  }
  const store = new LocalObjectStore(artifactPath(artifactRoot, ARTIFACT_PAYLOAD));
  const actualKeys = await store.list();
  const expectedKeys = metadata.objects.map((item) => item.key).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) throw new Error("GFS_ARTIFACT_FILE_SET_INVALID");
  for (const descriptor of metadata.objects) {
    if (!/^[a-f0-9]{64}$/.test(descriptor.sha256 || "") || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1) {
      throw new Error("GFS_ARTIFACT_DESCRIPTOR_INVALID");
    }
    const body = await store.get(descriptor.key);
    if (body.byteLength !== descriptor.bytes || sha256(body) !== descriptor.sha256) throw new Error("GFS_ARTIFACT_INTEGRITY_FAILED");
  }
  const { latest, manifest } = await readLatestPublication(store);
  if (latest.runId !== metadata.runId || latest.manifest.sha256 !== metadata.manifest.sha256 || manifest.status !== "COMPLETE") {
    throw new Error("GFS_ARTIFACT_PUBLICATION_MISMATCH");
  }
  const periods = manifest.forecasts.filter((item) => item.forecastHour === 12).map((item) => item.accumulationPeriod).sort();
  if (JSON.stringify(periods) !== JSON.stringify(["PT12H", "PT6H"])) throw new Error("GFS_ARTIFACT_F012_CONTRACT_INVALID");
  const indexBody = await store.tryGet(indexManifestKey(latest.runId));
  if (indexBody) {
    const indexManifest = parseJson(indexBody, "GFS_ARTIFACT_INDEX_INVALID");
    validateIndexManifest(indexManifest, { runId: latest.runId, sourceManifest: latest.manifest });
  }
  return { metadata, latest, manifest };
}
