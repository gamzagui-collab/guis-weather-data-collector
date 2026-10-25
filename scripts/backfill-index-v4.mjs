import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { parseJson, sha256, validateForecastShard, validateGridShard } from "../src/contracts.mjs";
import { buildRangeIndexObjects, validateIndexV4Manifest, validateIndexV4Segment,
  validateIndexV4Route, validateIndexV4Spatial } from "../src/indexes-v4.mjs";
import { LocalObjectStore } from "../src/object-store.mjs";
import { LATEST_144H_KEY } from "../src/publisher-144.mjs";

const sourceIndex = process.argv.indexOf("--source-store");
const outputIndex = process.argv.indexOf("--output-store");
if (sourceIndex < 0 || !process.argv[sourceIndex + 1] || outputIndex < 0 || !process.argv[outputIndex + 1]) {
  throw new Error("GFS_INDEX_V4_STORE_ARGUMENTS_REQUIRED");
}
const source = new LocalObjectStore(resolve(process.argv[sourceIndex + 1]));
const outputRoot = resolve(process.argv[outputIndex + 1]);
const output = new LocalObjectStore(outputRoot);
async function verifiedObject(item, code, validator = null) {
  const body = await source.get(item.key);
  if (body.byteLength !== item.bytes || sha256(body) !== item.sha256) throw new Error(code);
  const value = parseJson(body, `${code}_JSON_INVALID`);
  if (validator) validator(value);
  return value;
}
const latest = parseJson(await source.get(LATEST_144H_KEY), "GFS_INDEX_V4_LATEST_INVALID");
const manifest = await verifiedObject(latest.manifest, "GFS_INDEX_V4_SOURCE_MANIFEST_INTEGRITY_FAILED");
const grid = await verifiedObject(manifest.grid, "GFS_INDEX_V4_SOURCE_GRID_INTEGRITY_FAILED", validateGridShard);
const forecasts = [];
for (const descriptor of manifest.forecasts) forecasts.push({ descriptor,
  value: await verifiedObject(descriptor, "GFS_INDEX_V4_SOURCE_FORECAST_INTEGRITY_FAILED",
    (value) => validateForecastShard(value, grid.grid.points.length)) });
const plan = buildRangeIndexObjects({ runId: latest.runId, sourceManifest: latest.manifest, grid, forecasts });
await rm(outputRoot, { recursive: true, force: true });
for (const item of plan.pointObjects) {
  await output.put(item.key, item.body);
  for (const segment of item.segments) validateIndexV4Segment(parseJson(item.body.subarray(segment.offset, segment.offset + segment.bytes)), {
    runId: latest.runId, sourceManifest: latest.manifest,
    point: { pointId: item.pointId }, segment
  });
}
for (const item of plan.spatialObjects) {
  await output.put(item.key, item.body);
  validateIndexV4Spatial(parseJson(await output.get(item.key)), {
    runId: latest.runId, sourceManifest: latest.manifest, descriptor: item
  });
}
for (const item of plan.routeObjects) {
  await output.put(item.key, item.body);
  validateIndexV4Route(parseJson(await output.get(item.key)), {
    runId: latest.runId, sourceManifest: latest.manifest, pointId: item.pointId
  });
}
await output.put(plan.manifestObject.key, plan.manifestObject.body, { atomic: true });
validateIndexV4Manifest(parseJson(await output.get(plan.manifestObject.key)), {
  runId: latest.runId, sourceManifest: latest.manifest
});
const all = [...plan.pointObjects, ...plan.spatialObjects, ...plan.routeObjects, plan.manifestObject];
process.stdout.write(`${JSON.stringify({ status: "INDEX_V4_READY", runId: latest.runId,
  objectCount: all.length, spatialCatalogCount: plan.spatialObjects.length,
  pointBlobCount: plan.pointObjects.length, routeCount: plan.routeObjects.length,
  totalBytes: all.reduce((sum, item) => sum + item.bytes, 0),
  manifestBytes: plan.manifestObject.bytes, manifestSha256: plan.manifestObject.sha256 })}\n`);
