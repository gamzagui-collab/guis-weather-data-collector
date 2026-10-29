import {
  LATEST_SCHEMA,
  MANIFEST_SCHEMA,
  encodeObject,
  parseJson,
  sha256,
  validateForecastShard,
  validateGridShard
} from "./contracts.mjs";
import { assertObjectStore } from "./object-store.mjs";
import {
  INDEX_V5_PUBLICATION_SCHEMA,
  indexV5ManifestKey,
  indexV5PointKey,
  indexV5PublicationKey,
  validateIndexV5Catalog,
  validateIndexV5Manifest,
  validateIndexV5PointMetadata,
  validateIndexV5PointSegment,
  validateIndexV5Publication
} from "./indexes-v5.mjs";
import {
  LATEST_144H_KEY,
  readLatestOperationalPublication144,
  readLatestPublication144
} from "./publisher-144.mjs";

function sameDescriptor(left, right) {
  return left?.key === right?.key && left?.bytes === right?.bytes && left?.sha256 === right?.sha256;
}

function checkedInventory(inventory) {
  if (!Array.isArray(inventory)) throw new Error("GFS_V5_RECOVERY_INVENTORY_INVALID");
  const result = new Map();
  for (const item of inventory) {
    if (!item || typeof item.key !== "string" || !Number.isSafeInteger(item.bytes) || item.bytes < 1
      || !/^[a-f0-9]{64}$/.test(item.sha256 || "") || result.has(item.key)
      || !["application/json", "application/octet-stream"].includes(item.contentType)) {
      throw new Error("GFS_V5_RECOVERY_INVENTORY_INVALID");
    }
    result.set(item.key, structuredClone(item));
  }
  return result;
}

async function verifiedBody(store, descriptor, code) {
  const body = await store.get(descriptor.key);
  if (body.byteLength !== descriptor.bytes || sha256(body) !== descriptor.sha256) throw new Error(code);
  return body;
}

async function verifiedInventoryBody(store, inventory, key) {
  const item = inventory.get(key);
  if (!item) throw new Error("GFS_V5_RECOVERY_OBJECT_MISSING");
  const body = await verifiedBody(store, item, "GFS_V5_RECOVERY_OBJECT_INTEGRITY_FAILED");
  return { item, body };
}

export async function prepareV5PublicationRecovery(store, {
  expectedRunId,
  expectedLatestSha256,
  inventory
} = {}) {
  assertObjectStore(store);
  if (!/^\d{8}T\d{6}Z$/.test(expectedRunId || "") || !/^[a-f0-9]{64}$/.test(expectedLatestSha256 || "")) {
    throw new Error("GFS_V5_RECOVERY_EXPECTATION_INVALID");
  }
  const latestBody = await store.get(LATEST_144H_KEY);
  if (sha256(latestBody) !== expectedLatestSha256) throw new Error("GFS_V5_RECOVERY_LATEST_PRECONDITION_FAILED");
  const latest = parseJson(latestBody, "GFS_V5_RECOVERY_LATEST_JSON_INVALID");
  if (latest.runId !== expectedRunId) throw new Error("GFS_V5_RECOVERY_FIXED_RUN_MISMATCH");

  if (latest.publicReadiness?.status === "COMPLETE" && latest.indexes?.v5?.publication) {
    await readLatestOperationalPublication144(store);
    return { status: "ALREADY_COMPLETE", runId: expectedRunId, expectedLatestSha256,
      latest, latestObject: { key: LATEST_144H_KEY, body: latestBody, bytes: latestBody.byteLength,
        sha256: expectedLatestSha256 }, publicationObject: null };
  }

  const { manifest, index } = await readLatestPublication144(store);
  if (latest.schemaVersion !== LATEST_SCHEMA || manifest.schemaVersion !== MANIFEST_SCHEMA
    || manifest.runId !== expectedRunId || index.runId !== expectedRunId) {
    throw new Error("GFS_V5_RECOVERY_SOURCE_INVALID");
  }
  const gridBody = await verifiedBody(store, manifest.grid, "GFS_V5_RECOVERY_SOURCE_GRID_INTEGRITY_FAILED");
  const grid = validateGridShard(parseJson(gridBody, "GFS_V5_RECOVERY_SOURCE_GRID_JSON_INVALID"));
  for (const descriptor of manifest.forecasts) {
    const body = await verifiedBody(store, descriptor, "GFS_V5_RECOVERY_SOURCE_FORECAST_INTEGRITY_FAILED");
    validateForecastShard(parseJson(body, "GFS_V5_RECOVERY_SOURCE_FORECAST_JSON_INVALID"), grid.grid.points.length);
  }

  const inventoryMap = checkedInventory(inventory);
  const v5Key = indexV5ManifestKey(expectedRunId);
  const { item: v5Descriptor, body: v5Body } = await verifiedInventoryBody(store, inventoryMap, v5Key);
  if (v5Descriptor.contentType !== "application/json") throw new Error("GFS_V5_RECOVERY_CONTENT_TYPE_INVALID");
  const v5 = parseJson(v5Body, "GFS_V5_RECOVERY_MANIFEST_JSON_INVALID");
  validateIndexV5Manifest(v5, { runId: expectedRunId, sourceManifest: latest.manifest, sourceGrid: manifest.grid });

  const requiredKeys = new Set([v5Key]);
  const objects = [];
  for (const window of v5.windows) {
    requiredKeys.add(window.catalog.key);
    const { item, body } = await verifiedInventoryBody(store, inventoryMap, window.catalog.key);
    if (item.contentType !== "application/json" || !sameDescriptor(item, window.catalog)) {
      throw new Error("GFS_V5_RECOVERY_CATALOG_DESCRIPTOR_MISMATCH");
    }
    validateIndexV5Catalog(parseJson(body, "GFS_V5_RECOVERY_CATALOG_JSON_INVALID"), {
      runId: expectedRunId, sourceManifest: latest.manifest, window
    });
    objects.push(item);
  }

  const sourcePoints = new Map(grid.grid.points.map((point) => [point.id, point]));
  for (let pointId = 0; pointId < v5.grid.pointCount; pointId += 1) {
    const key = indexV5PointKey(expectedRunId, pointId);
    requiredKeys.add(key);
    const { item, body } = await verifiedInventoryBody(store, inventoryMap, key);
    const sourcePoint = sourcePoints.get(pointId);
    const pointObject = { key, bytes: item.bytes, sha256: item.sha256, pointId,
      latitude: Number(item.customMetadata?.latitude), longitude: Number(item.customMetadata?.longitude),
      segments: JSON.parse(item.customMetadata?.segments || "null") };
    if (item.contentType !== "application/octet-stream" || !sourcePoint
      || pointObject.latitude !== sourcePoint.latitude || pointObject.longitude !== sourcePoint.longitude) {
      throw new Error("GFS_V5_RECOVERY_POINT_DESCRIPTOR_MISMATCH");
    }
    const segments = validateIndexV5PointMetadata(item.customMetadata, {
      pointObject, manifestDescriptor: v5Descriptor
    });
    for (const segment of segments) {
      const bytes = body.subarray(segment.offset, segment.offset + segment.bytes);
      if (sha256(bytes) !== segment.sha256) throw new Error("GFS_V5_RECOVERY_POINT_RANGE_INTEGRITY_FAILED");
      const window = v5.windows.find((candidate) => candidate.id === segment.id);
      validateIndexV5PointSegment(parseJson(bytes, "GFS_V5_RECOVERY_POINT_JSON_INVALID"), {
        runId: expectedRunId, sourceManifest: latest.manifest, indexManifest: v5Descriptor,
        point: { pointId, latitude: sourcePoint.latitude, longitude: sourcePoint.longitude }, window
      });
    }
    objects.push(item);
  }
  objects.push(v5Descriptor);
  if (inventoryMap.size !== requiredKeys.size || [...inventoryMap.keys()].some((key) => !requiredKeys.has(key))) {
    throw new Error("GFS_V5_RECOVERY_OBJECT_SET_INVALID");
  }

  const publication = {
    schemaVersion: INDEX_V5_PUBLICATION_SCHEMA,
    status: "COMPLETE",
    runId: expectedRunId,
    sourceManifest: latest.manifest,
    sourceGrid: manifest.grid,
    indexManifest: { key: v5Descriptor.key, bytes: v5Descriptor.bytes, sha256: v5Descriptor.sha256 },
    objectCount: objects.length,
    totalBytes: objects.reduce((sum, item) => sum + item.bytes, 0),
    objects
  };
  validateIndexV5Publication(publication, { runId: expectedRunId, sourceManifest: latest.manifest,
    sourceGrid: manifest.grid, indexManifest: publication.indexManifest });
  const publicationEncoded = encodeObject(publication);
  const publicationObject = { key: indexV5PublicationKey(expectedRunId), ...publicationEncoded };
  const recoveredLatest = structuredClone(latest);
  recoveredLatest.indexes = { ...recoveredLatest.indexes, v5: {
    manifest: publication.indexManifest,
    publication: { key: publicationObject.key, bytes: publicationObject.bytes, sha256: publicationObject.sha256 }
  } };
  recoveredLatest.publicReadiness = { status: "COMPLETE", sourceManifest: recoveredLatest.manifest,
    indexVersion: "v5", indexManifest: publication.indexManifest, noDerivedPrecipitation: true };
  const latestEncoded = encodeObject(recoveredLatest);
  return {
    status: "RECOVERY_READY",
    runId: expectedRunId,
    expectedLatestSha256,
    publication,
    publicationObject,
    latest: recoveredLatest,
    latestObject: { key: LATEST_144H_KEY, ...latestEncoded }
  };
}

export async function recoverV5Publication(store, options = {}) {
  const plan = await prepareV5PublicationRecovery(store, options);
  if (plan.status === "ALREADY_COMPLETE") return plan;
  await store.put(plan.publicationObject.key, plan.publicationObject.body);
  const storedPublication = await verifiedBody(store, plan.publicationObject, "GFS_V5_RECOVERY_PUBLICATION_INTEGRITY_FAILED");
  validateIndexV5Publication(parseJson(storedPublication), { runId: plan.runId,
    sourceManifest: plan.latest.manifest, sourceGrid: plan.publication.sourceGrid,
    indexManifest: plan.publication.indexManifest });
  if (options.beforeLatestSwap) await options.beforeLatestSwap(plan);
  const currentLatest = await store.get(LATEST_144H_KEY);
  if (sha256(currentLatest) !== plan.expectedLatestSha256) throw new Error("GFS_V5_RECOVERY_LATEST_RACE");
  await store.put(LATEST_144H_KEY, plan.latestObject.body, { atomic: true });
  await readLatestOperationalPublication144(store);
  return { ...plan, status: "RECOVERED" };
}
