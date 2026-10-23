import {
  LATEST_SCHEMA,
  MANIFEST_SCHEMA,
  STATUS_SCHEMA,
  encodeObject,
  parseJson,
  sha256,
  splitDataset,
  validateCoverage,
  validateForecastShard,
  validateGridShard
} from "./contracts.mjs";
import { assertObjectStore } from "./object-store.mjs";
import {
  buildWindowedTileIndexObjects,
  indexV2ManifestKey,
  validateIndexV2Manifest,
  validateIndexV2Tile
} from "./indexes-v2.mjs";
import { GFS_144H_NAMESPACE, assertGfs144ForecastHours, gfs144ScopedKey } from "./horizon-144.mjs";

export const LATEST_144H_KEY = gfs144ScopedKey("latest.json");
export const STATUS_144H_KEY = gfs144ScopedKey("status/collector.json");

async function verifyStoredObject(store, descriptor, validator) {
  const body = await store.get(descriptor.key);
  if (body.byteLength !== descriptor.bytes || sha256(body) !== descriptor.sha256) throw new Error("GFS_144H_OBJECT_INTEGRITY_FAILED");
  const value = parseJson(body);
  if (validator) validator(value);
  return value;
}

export function buildRunObjects144(dataset) {
  validateCoverage(dataset?.coverage);
  if (dataset.coverage.label !== "144H") throw new Error("GFS_144H_DATASET_COVERAGE_INVALID");
  assertGfs144ForecastHours(dataset.coverage.expectedForecastHours);
  const { runId, common, grid, forecasts } = splitDataset(dataset);
  const prefix = gfs144ScopedKey(`runs/${runId}`);
  const gridEncoded = encodeObject(grid);
  const gridObject = { key: `${prefix}/grid.json`, ...gridEncoded };
  const forecastObjects = forecasts.map((forecast) => {
    const encoded = encodeObject(forecast);
    return {
      key: `${prefix}/forecasts/${forecast.frameId}.json`,
      frameId: forecast.frameId,
      forecastHour: forecast.frame.forecastHour,
      validAt: forecast.frame.validAt,
      accumulationStart: forecast.frame.accumulationStart,
      accumulationEnd: forecast.frame.accumulationEnd,
      accumulationPeriod: forecast.frame.accumulationPeriod,
      sourceDataSha256: forecast.frame.sourceDataSha256,
      ...encoded
    };
  });
  const latestValidAt = forecasts.reduce((latest, item) => latest > item.frame.validAt ? latest : item.frame.validAt, "");
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA,
    status: "COMPLETE",
    namespace: GFS_144H_NAMESPACE,
    dataMode: "OPERATIONAL_144H",
    runId,
    ...common,
    latestValidAt,
    grid: { key: gridObject.key, sha256: gridObject.sha256, bytes: gridObject.bytes },
    forecasts: forecastObjects.map(({ body, ...item }) => item),
    objectCount: forecastObjects.length + 1
  };
  const manifestEncoded = encodeObject(manifest);
  const manifestObject = { key: `${prefix}/manifest.json`, ...manifestEncoded };
  const latest = {
    schemaVersion: LATEST_SCHEMA,
    status: "AVAILABLE",
    namespace: GFS_144H_NAMESPACE,
    dataMode: "OPERATIONAL_144H",
    runId,
    modelRunAt: dataset.modelRunAt,
    fetchedAt: dataset.fetchedAt,
    latestValidAt,
    coverage: dataset.coverage,
    manifest: { key: manifestObject.key, sha256: manifestObject.sha256, bytes: manifestObject.bytes }
  };
  const indexPlan = buildWindowedTileIndexObjects({
    runId,
    sourceManifest: latest.manifest,
    grid,
    forecasts: forecasts.map((value, index) => ({ descriptor: forecastObjects[index], value }))
  });
  return { runId, gridObject, forecastObjects, manifest, manifestObject, indexPlan, latest };
}

export async function publishDataset144(store, dataset, { now = new Date(), beforeLatestSwap } = {}) {
  assertObjectStore(store);
  const plan = buildRunObjects144(dataset);
  const startedAt = now.toISOString();
  try {
    await store.put(plan.gridObject.key, plan.gridObject.body);
    for (const item of plan.forecastObjects) await store.put(item.key, item.body);
    const grid = await verifyStoredObject(store, plan.gridObject, validateGridShard);
    for (const item of plan.forecastObjects) {
      await verifyStoredObject(store, item, (value) => validateForecastShard(value, grid.grid.points.length));
    }
    await store.put(plan.manifestObject.key, plan.manifestObject.body);
    await verifyStoredObject(store, plan.manifestObject, (value) => {
      if (value.schemaVersion !== MANIFEST_SCHEMA || value.status !== "COMPLETE" || value.namespace !== GFS_144H_NAMESPACE
        || value.runId !== plan.runId || value.coverage?.label !== "144H") throw new Error("GFS_144H_MANIFEST_INVALID");
    });
    for (const item of plan.indexPlan.tileObjects) await store.put(item.key, item.body);
    for (const item of plan.indexPlan.tileObjects) {
      await verifyStoredObject(store, item, (value) => validateIndexV2Tile(value, {
        runId: plan.runId, sourceManifest: plan.latest.manifest, descriptor: item
      }));
    }
    await store.put(plan.indexPlan.manifestObject.key, plan.indexPlan.manifestObject.body);
    await verifyStoredObject(store, plan.indexPlan.manifestObject, (value) => validateIndexV2Manifest(value, {
      runId: plan.runId, sourceManifest: plan.latest.manifest
    }));
    const status = encodeObject({
      schemaVersion: STATUS_SCHEMA,
      status: "SUCCESS",
      namespace: GFS_144H_NAMESPACE,
      attemptedRunId: plan.runId,
      modelRunAt: plan.latest.modelRunAt,
      fetchedAt: plan.latest.fetchedAt,
      latestValidAt: plan.latest.latestValidAt,
      coverage: plan.latest.coverage,
      attemptedAt: startedAt,
      completedAt: new Date(now).toISOString(),
      publicationState: "READY_TO_PUBLISH",
      failureCode: null
    });
    await store.put(STATUS_144H_KEY, status.body, { atomic: true });
    if (beforeLatestSwap) await beforeLatestSwap(plan);
    const latestEncoded = encodeObject(plan.latest);
    await store.put(LATEST_144H_KEY, latestEncoded.body, { atomic: true });
    return {
      runId: plan.runId,
      latest: plan.latest,
      objectCount: plan.forecastObjects.length + plan.indexPlan.tileObjects.length + 5,
      runBytes: plan.gridObject.bytes + plan.forecastObjects.reduce((sum, item) => sum + item.bytes, 0)
        + plan.indexPlan.tileObjects.reduce((sum, item) => sum + item.bytes, 0)
        + plan.indexPlan.manifestObject.bytes + plan.manifestObject.bytes,
      manifestSha256: plan.manifestObject.sha256,
      indexManifestSha256: plan.indexPlan.manifestObject.sha256
    };
  } catch (error) {
    const failure = encodeObject({
      schemaVersion: STATUS_SCHEMA,
      status: "FAILED",
      namespace: GFS_144H_NAMESPACE,
      attemptedRunId: plan.runId,
      modelRunAt: plan.latest.modelRunAt,
      fetchedAt: plan.latest.fetchedAt,
      latestValidAt: plan.latest.latestValidAt,
      coverage: plan.latest.coverage,
      attemptedAt: startedAt,
      completedAt: new Date(now).toISOString(),
      publicationState: "NOT_PUBLISHED",
      failureCode: String(error?.message || "GFS_144H_COLLECTION_FAILED").slice(0, 120)
    });
    await store.put(STATUS_144H_KEY, failure.body, { atomic: true });
    throw error;
  }
}

export async function readLatestPublication144(store) {
  assertObjectStore(store);
  const latestBody = await store.get(LATEST_144H_KEY);
  const latest = parseJson(latestBody, "GFS_144H_LATEST_JSON_INVALID");
  if (latest.schemaVersion !== LATEST_SCHEMA || latest.status !== "AVAILABLE" || latest.namespace !== GFS_144H_NAMESPACE
    || latest.dataMode !== "OPERATIONAL_144H" || latest.coverage?.label !== "144H") throw new Error("GFS_144H_LATEST_INVALID");
  const manifestBody = await store.get(latest.manifest?.key);
  if (manifestBody.byteLength !== latest.manifest.bytes || sha256(manifestBody) !== latest.manifest.sha256) {
    throw new Error("GFS_144H_MANIFEST_INTEGRITY_FAILED");
  }
  const manifest = parseJson(manifestBody);
  if (manifest.schemaVersion !== MANIFEST_SCHEMA || manifest.status !== "COMPLETE" || manifest.namespace !== GFS_144H_NAMESPACE
    || manifest.runId !== latest.runId) throw new Error("GFS_144H_MANIFEST_INVALID");
  const indexBody = await store.get(indexV2ManifestKey(latest.runId));
  const index = parseJson(indexBody, "GFS_144H_INDEX_JSON_INVALID");
  validateIndexV2Manifest(index, { runId: latest.runId, sourceManifest: latest.manifest });
  return { latest, manifest, index };
}

export async function latestRunMatches144(store, modelRunAt) {
  try {
    const { latest } = await readLatestPublication144(store);
    return Date.parse(latest.modelRunAt) === Date.parse(modelRunAt);
  } catch (error) {
    if (error.message === "OBJECT_NOT_FOUND") return false;
    throw error;
  }
}
