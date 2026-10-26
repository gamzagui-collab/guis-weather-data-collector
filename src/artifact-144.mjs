import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { canonicalJson, parseJson, sha256 } from "./contracts.mjs";
import { GFS_144H_NAMESPACE } from "./horizon-144.mjs";
import { indexV2ManifestKey, validateIndexV2Manifest, validateIndexV2Tile } from "./indexes-v2.mjs";
import { validateIndexV5Publication } from "./indexes-v5.mjs";
import { LocalObjectStore } from "./object-store.mjs";
import { LATEST_144H_KEY, STATUS_144H_KEY, readLatestOperationalPublication144 } from "./publisher-144.mjs";

export const ARTIFACT_144H_SCHEMA = "weather.gfs.collector-artifact.144h.v1";
export const ARTIFACT_144H_METADATA = "metadata.json";
export const ARTIFACT_144H_PAYLOAD = "payload";

function exactIdentity(value, pattern, code) {
  if (!pattern.test(String(value || ""))) throw new Error(code);
  return String(value);
}

function artifactPath(root, relative) {
  const base = resolve(root);
  const target = resolve(base, ...String(relative).replaceAll("\\", "/").split("/"));
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error("GFS_144H_ARTIFACT_PATH_ESCAPE");
  return target;
}

function assertScopedKey(key) {
  if (!String(key || "").startsWith(`${GFS_144H_NAMESPACE}/`)) throw new Error("GFS_144H_ARTIFACT_KEY_OUTSIDE_NAMESPACE");
  return key;
}

async function readVerified(store, descriptor, code) {
  assertScopedKey(descriptor?.key);
  const body = await store.get(descriptor.key);
  if (body.byteLength !== descriptor.bytes || sha256(body) !== descriptor.sha256) throw new Error(code);
  return body;
}

export async function createPublicationArtifact144({ storeRoot, artifactRoot, provenance }) {
  const repository = exactIdentity(provenance?.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "GFS_144H_ARTIFACT_REPOSITORY_INVALID");
  const ref = exactIdentity(provenance?.ref, /^main$/, "GFS_144H_ARTIFACT_REF_INVALID");
  const commit = exactIdentity(provenance?.commit, /^[a-f0-9]{40}$/, "GFS_144H_ARTIFACT_COMMIT_INVALID");
  const workflowRunId = exactIdentity(provenance?.workflowRunId, /^\d+$/, "GFS_144H_ARTIFACT_RUN_ID_INVALID");
  const source = new LocalObjectStore(storeRoot);
  const { latest, manifest, index, v5, publication } = await readLatestOperationalPublication144(source);
  const indexBody = await source.get(indexV2ManifestKey(latest.runId));
  const statusBody = await source.get(STATUS_144H_KEY);
  const status = parseJson(statusBody, "GFS_144H_ARTIFACT_STATUS_INVALID");
  if (status.status !== "SUCCESS" || status.namespace !== GFS_144H_NAMESPACE || status.attemptedRunId !== latest.runId) {
    throw new Error("GFS_144H_ARTIFACT_COLLECTION_INCOMPLETE");
  }
  const tileDescriptors = index.windows.flatMap((window) => window.tiles);
  for (const item of tileDescriptors) {
    const body = await readVerified(source, item, "GFS_144H_ARTIFACT_INDEX_INTEGRITY_FAILED");
    validateIndexV2Tile(parseJson(body), { runId: latest.runId, sourceManifest: latest.manifest, descriptor: item });
  }
  const baseKeys = [manifest.grid.key, ...manifest.forecasts.map((item) => item.key),
    ...tileDescriptors.map((item) => item.key), indexV2ManifestKey(latest.runId), latest.manifest.key,
    STATUS_144H_KEY, LATEST_144H_KEY, latest.indexes.v5.publication.key];
  validateIndexV5Publication(publication, {
    runId: latest.runId, sourceManifest: latest.manifest, sourceGrid: manifest.grid,
    indexManifest: latest.indexes.v5.manifest
  });
  const keys = [...baseKeys, ...publication.objects.map((item) => item.key)];
  if (new Set(keys).size !== keys.length || keys.some((key) => !key.startsWith(`${GFS_144H_NAMESPACE}/`))) {
    throw new Error("GFS_144H_ARTIFACT_FILE_SET_INVALID");
  }
  const destination = new LocalObjectStore(artifactPath(artifactRoot, ARTIFACT_144H_PAYLOAD));
  await rm(resolve(artifactRoot), { recursive: true, force: true });
  const objects = [];
  const v5Descriptors = new Map(publication.objects.map((item) => [item.key, item]));
  for (const key of keys) {
    const body = await source.get(key);
    const v5Descriptor = v5Descriptors.get(key);
    const object = { key, bytes: body.byteLength, sha256: sha256(body),
      contentType: v5Descriptor?.contentType || "application/json",
      ...(v5Descriptor?.customMetadata ? { customMetadata: v5Descriptor.customMetadata } : {}) };
    await destination.put(key, body);
    objects.push(object);
  }
  const metadata = {
    schemaVersion: ARTIFACT_144H_SCHEMA,
    namespace: GFS_144H_NAMESPACE,
    dataMode: "OPERATIONAL_144H",
    repository,
    ref,
    commit,
    workflowRunId,
    runId: latest.runId,
    modelRunAt: latest.modelRunAt,
    manifest: latest.manifest,
    indexManifest: {
      key: indexV2ManifestKey(latest.runId),
      bytes: indexBody.byteLength,
      sha256: sha256(indexBody)
    },
    v5IndexManifest: latest.indexes.v5.manifest,
    v5Publication: latest.indexes.v5.publication,
    coverage: latest.coverage,
    objectCount: objects.length,
    objects
  };
  await mkdir(resolve(artifactRoot), { recursive: true });
  await writeFile(artifactPath(artifactRoot, ARTIFACT_144H_METADATA), canonicalJson(metadata), "utf8");
  return metadata;
}

export async function verifyPublicationArtifact144({ artifactRoot, expected }) {
  const metadata = parseJson(await readFile(artifactPath(artifactRoot, ARTIFACT_144H_METADATA)), "GFS_144H_ARTIFACT_METADATA_INVALID");
  if (metadata.schemaVersion !== ARTIFACT_144H_SCHEMA || metadata.namespace !== GFS_144H_NAMESPACE
    || metadata.dataMode !== "OPERATIONAL_144H" || metadata.coverage?.label !== "144H") {
    throw new Error("GFS_144H_ARTIFACT_SCHEMA_INVALID");
  }
  for (const [field, value] of Object.entries(expected || {})) {
    if (String(metadata[field]) !== String(value)) throw new Error(`GFS_144H_ARTIFACT_${field.toUpperCase()}_MISMATCH`);
  }
  if (!Array.isArray(metadata.objects) || metadata.objectCount !== metadata.objects.length || metadata.objects.length < 100) {
    throw new Error("GFS_144H_ARTIFACT_OBJECTS_INVALID");
  }
  const store = new LocalObjectStore(artifactPath(artifactRoot, ARTIFACT_144H_PAYLOAD));
  const actualKeys = await store.list();
  const expectedKeys = metadata.objects.map((item) => assertScopedKey(item.key)).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) throw new Error("GFS_144H_ARTIFACT_FILE_SET_INVALID");
  for (const descriptor of metadata.objects) {
    if (!/^[a-f0-9]{64}$/.test(descriptor.sha256 || "") || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1) {
      throw new Error("GFS_144H_ARTIFACT_DESCRIPTOR_INVALID");
    }
    await readVerified(store, descriptor, "GFS_144H_ARTIFACT_INTEGRITY_FAILED");
  }
  const { latest, manifest, index, v5, publication } = await readLatestOperationalPublication144(store);
  if (latest.runId !== metadata.runId || latest.manifest.sha256 !== metadata.manifest.sha256
    || manifest.status !== "COMPLETE" || index.status !== "COMPLETE") {
    throw new Error("GFS_144H_ARTIFACT_PUBLICATION_MISMATCH");
  }
  validateIndexV2Manifest(index, { runId: latest.runId, sourceManifest: latest.manifest });
  const indexDescriptor = metadata.indexManifest;
  const indexBody = await readVerified(store, indexDescriptor, "GFS_144H_ARTIFACT_INDEX_INTEGRITY_FAILED");
  if (indexDescriptor.key !== indexV2ManifestKey(latest.runId) || indexBody.byteLength !== indexDescriptor.bytes) {
    throw new Error("GFS_144H_ARTIFACT_INDEX_MISMATCH");
  }
  const f012 = manifest.forecasts.filter((item) => item.forecastHour === 12).map((item) => item.accumulationPeriod).sort();
  if (!f012.includes("PT12H") || !f012.includes("PT6H")) throw new Error("GFS_144H_ARTIFACT_F012_CONTRACT_INVALID");
  if (metadata.v5IndexManifest?.sha256 !== latest.indexes.v5.manifest.sha256
    || metadata.v5Publication?.sha256 !== latest.indexes.v5.publication.sha256
    || v5.status !== "COMPLETE" || publication.status !== "COMPLETE") {
    throw new Error("GFS_144H_ARTIFACT_V5_MISMATCH");
  }
  return { metadata, latest, manifest, index, v5, publication };
}
