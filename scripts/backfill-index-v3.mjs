import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { parseJson, sha256, validateForecastShard, validateGridShard } from "../src/contracts.mjs";
import {
  buildPointWindowIndexObjects,
  validateIndexV3Contracts,
  validateIndexV3Manifest,
  validateIndexV3Point,
  validateIndexV3Spatial
} from "../src/indexes-v3.mjs";
import { LocalObjectStore } from "../src/object-store.mjs";
import { LATEST_144H_KEY } from "../src/publisher-144.mjs";

const sourceIndex = process.argv.indexOf("--source-store");
const outputIndex = process.argv.indexOf("--output-store");
if (sourceIndex < 0 || !process.argv[sourceIndex + 1] || outputIndex < 0 || !process.argv[outputIndex + 1]) {
  throw new Error("GFS_INDEX_V3_STORE_ARGUMENTS_REQUIRED");
}
const source = new LocalObjectStore(resolve(process.argv[sourceIndex + 1]));
const outputRoot = resolve(process.argv[outputIndex + 1]);
const output = new LocalObjectStore(outputRoot);

async function verifiedObject(descriptor, code, validator = null) {
  const body = await source.get(descriptor.key);
  if (body.byteLength !== descriptor.bytes || sha256(body) !== descriptor.sha256) throw new Error(code);
  const value = parseJson(body, `${code}_JSON_INVALID`);
  if (validator) validator(value);
  return value;
}

const latest = parseJson(await source.get(LATEST_144H_KEY), "GFS_INDEX_V3_LATEST_INVALID");
if (latest?.schemaVersion !== "weather.gfs.latest.v2" || latest.status !== "AVAILABLE"
  || latest.namespace !== "horizons/144h" || latest.dataMode !== "OPERATIONAL_144H") {
  throw new Error("GFS_INDEX_V3_LATEST_INVALID");
}
const manifest = await verifiedObject(latest.manifest, "GFS_INDEX_V3_SOURCE_MANIFEST_INTEGRITY_FAILED");
if (manifest?.schemaVersion !== "weather.gfs.manifest.v1" || manifest.status !== "COMPLETE"
  || manifest.runId !== latest.runId || manifest.modelRunAt !== latest.modelRunAt
  || !Array.isArray(manifest.forecasts) || !manifest.forecasts.length) throw new Error("GFS_INDEX_V3_SOURCE_MANIFEST_INVALID");
const grid = await verifiedObject(manifest.grid, "GFS_INDEX_V3_SOURCE_GRID_INTEGRITY_FAILED", validateGridShard);
const forecasts = [];
for (const descriptor of manifest.forecasts) {
  forecasts.push({ descriptor, value: await verifiedObject(descriptor,
    "GFS_INDEX_V3_SOURCE_FORECAST_INTEGRITY_FAILED", (value) => validateForecastShard(value, grid.grid.points.length)) });
}
const plan = buildPointWindowIndexObjects({ runId: latest.runId, sourceManifest: latest.manifest, grid, forecasts });

await rm(outputRoot, { recursive: true, force: true });
for (const item of plan.contractObjects) {
  await output.put(item.key, item.body);
  validateIndexV3Contracts(parseJson(await output.get(item.key)), {
    runId: latest.runId,
    sourceManifest: latest.manifest,
    descriptor: item
  });
}
for (const item of plan.pointObjects) {
  await output.put(item.key, item.body);
  validateIndexV3Point(parseJson(await output.get(item.key)), {
    runId: latest.runId,
    sourceManifest: latest.manifest,
    descriptor: item,
    windows: plan.manifest.windows
  });
}
for (const item of plan.spatialObjects) {
  await output.put(item.key, item.body);
  validateIndexV3Spatial(parseJson(await output.get(item.key)), {
    runId: latest.runId,
    sourceManifest: latest.manifest,
    descriptor: item
  });
}
await output.put(plan.manifestObject.key, plan.manifestObject.body, { atomic: true });
validateIndexV3Manifest(parseJson(await output.get(plan.manifestObject.key)), {
  runId: latest.runId,
  sourceManifest: latest.manifest
});

const allObjects = [...plan.contractObjects, ...plan.pointObjects, ...plan.spatialObjects, plan.manifestObject];
process.stdout.write(`${JSON.stringify({
  status: "INDEX_V3_READY",
  runId: latest.runId,
  modelRunAt: latest.modelRunAt,
  objectCount: allObjects.length,
  contractCatalogCount: plan.contractObjects.length,
  spatialCatalogCount: plan.spatialObjects.length,
  pointObjectCount: plan.pointObjects.length,
  totalBytes: allObjects.reduce((sum, item) => sum + item.bytes, 0),
  manifestBytes: plan.manifestObject.bytes,
  manifestSha256: plan.manifestObject.sha256
})}\n`);
