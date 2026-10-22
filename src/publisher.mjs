import {
  LATEST_SCHEMA,
  MANIFEST_SCHEMA,
  STATUS_SCHEMA,
  encodeObject,
  parseJson,
  sha256,
  splitDataset,
  validateForecastShard,
  validateGridShard
} from "./contracts.mjs";
import { assertObjectStore } from "./object-store.mjs";
import { buildTileIndexObjects, validateIndexManifest, validateIndexTile } from "./indexes.mjs";

export const LATEST_KEY = "latest.json";
export const STATUS_KEY = "status/collector.json";

async function verifyStoredObject(store, descriptor, validator) {
  const body = await store.get(descriptor.key);
  if (body.byteLength !== descriptor.bytes || sha256(body) !== descriptor.sha256) throw new Error("GFS_OBJECT_INTEGRITY_FAILED");
  const value = parseJson(body);
  if (validator) validator(value);
  return value;
}

export function buildRunObjects(dataset) {
  const { runId, common, grid, forecasts } = splitDataset(dataset);
  const prefix = `runs/${runId}`;
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
    runId,
    ...common,
    latestValidAt,
    grid: { key: gridObject.key, sha256: gridObject.sha256, bytes: gridObject.bytes },
    forecasts: forecastObjects.map(({ body, ...item }) => item),
    objectCount: forecastObjects.length + 1
  };
  const manifestEncoded = encodeObject(manifest);
  const manifestObject = { key: `${prefix}/manifest.json`, ...manifestEncoded };
  const indexPlan = buildTileIndexObjects({
    runId,
    sourceManifest: { key: manifestObject.key, sha256: manifestObject.sha256, bytes: manifestObject.bytes },
    grid,
    forecasts: forecasts.map((value, index) => ({ descriptor: forecastObjects[index], value }))
  });
  const latest = {
    schemaVersion: LATEST_SCHEMA,
    status: "AVAILABLE",
    runId,
    modelRunAt: dataset.modelRunAt,
    fetchedAt: dataset.fetchedAt,
    latestValidAt,
    coverage: dataset.coverage ?? null,
    manifest: { key: manifestObject.key, sha256: manifestObject.sha256, bytes: manifestObject.bytes }
  };
  return { runId, gridObject, forecastObjects, manifest, manifestObject, indexPlan, latest };
}

export async function publishDataset(store, dataset, { now = new Date(), beforeLatestSwap } = {}) {
  assertObjectStore(store);
  const plan = buildRunObjects(dataset);
  const startedAt = now.toISOString();
  try {
    await store.put(plan.gridObject.key, plan.gridObject.body);
    for (const item of plan.forecastObjects) await store.put(item.key, item.body);
    const grid = await verifyStoredObject(store, plan.gridObject, validateGridShard);
    for (const item of plan.forecastObjects) {
      await verifyStoredObject(store, item, (value) => validateForecastShard(value, grid.grid.points.length));
    }
    for (const item of plan.indexPlan.tileObjects) await store.put(item.key, item.body);
    for (const item of plan.indexPlan.tileObjects) {
      await verifyStoredObject(store, item, (value) => validateIndexTile(value, {
        runId: plan.runId,
        sourceManifest: plan.latest.manifest,
        descriptor: item,
        contractCount: plan.forecastObjects.length
      }));
    }
    await store.put(plan.indexPlan.manifestObject.key, plan.indexPlan.manifestObject.body);
    await verifyStoredObject(store, plan.indexPlan.manifestObject, (value) => validateIndexManifest(value, {
      runId: plan.runId,
      sourceManifest: plan.latest.manifest
    }));
    await store.put(plan.manifestObject.key, plan.manifestObject.body);
    await verifyStoredObject(store, plan.manifestObject, (value) => {
      if (value.schemaVersion !== MANIFEST_SCHEMA || value.status !== "COMPLETE" || value.runId !== plan.runId) {
        throw new Error("GFS_MANIFEST_INVALID");
      }
    });
    const status = encodeObject({
      schemaVersion: STATUS_SCHEMA,
      status: "SUCCESS",
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
    await store.put(STATUS_KEY, status.body, { atomic: true });
    if (beforeLatestSwap) await beforeLatestSwap(plan);
    const latestEncoded = encodeObject(plan.latest);
    await store.put(LATEST_KEY, latestEncoded.body, { atomic: true });
    return {
      runId: plan.runId,
      latest: plan.latest,
      objectCount: plan.manifest.objectCount + plan.indexPlan.tileObjects.length + 4,
      runBytes: plan.gridObject.bytes + plan.forecastObjects.reduce((sum, item) => sum + item.bytes, 0)
        + plan.indexPlan.tileObjects.reduce((sum, item) => sum + item.bytes, 0)
        + plan.indexPlan.manifestObject.bytes + plan.manifestObject.bytes,
      manifestSha256: plan.manifestObject.sha256
    };
  } catch (error) {
    const failure = encodeObject({
      schemaVersion: STATUS_SCHEMA,
      status: "FAILED",
      attemptedRunId: plan.runId,
      modelRunAt: plan.latest.modelRunAt,
      fetchedAt: plan.latest.fetchedAt,
      latestValidAt: plan.latest.latestValidAt,
      coverage: plan.latest.coverage,
      attemptedAt: startedAt,
      completedAt: new Date(now).toISOString(),
      publicationState: "NOT_PUBLISHED",
      failureCode: String(error?.message || "GFS_COLLECTION_FAILED").slice(0, 120)
    });
    await store.put(STATUS_KEY, failure.body, { atomic: true });
    throw error;
  }
}

export async function readLatestPublication(store) {
  assertObjectStore(store);
  const latestBody = await store.get(LATEST_KEY);
  const latest = parseJson(latestBody, "GFS_LATEST_JSON_INVALID");
  if (latest.schemaVersion !== LATEST_SCHEMA || latest.status !== "AVAILABLE") throw new Error("GFS_LATEST_INVALID");
  const manifestBody = await store.get(latest.manifest?.key);
  if (manifestBody.byteLength !== latest.manifest.bytes || sha256(manifestBody) !== latest.manifest.sha256) {
    throw new Error("GFS_MANIFEST_INTEGRITY_FAILED");
  }
  const manifest = parseJson(manifestBody);
  if (manifest.schemaVersion !== MANIFEST_SCHEMA || manifest.status !== "COMPLETE" || manifest.runId !== latest.runId) {
    throw new Error("GFS_MANIFEST_INVALID");
  }
  return { latest, manifest };
}

export async function latestRunMatches(store, modelRunAt) {
  try {
    const { latest } = await readLatestPublication(store);
    return Date.parse(latest.modelRunAt) === Date.parse(modelRunAt);
  } catch (error) {
    if (error.message === "OBJECT_NOT_FOUND") return false;
    throw error;
  }
}
