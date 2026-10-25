import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { encodeObject, parseJson, sha256, validateForecastShard, validateGridShard } from "../src/contracts.mjs";
import { buildCompactIndexObjects, validateIndexV5Catalog, validateIndexV5Manifest,
  validateIndexV5PointMetadata, validateIndexV5PointSegment } from "../src/indexes-v5.mjs";
import { LocalObjectStore } from "../src/object-store.mjs";
import { LATEST_144H_KEY } from "../src/publisher-144.mjs";

const sourceIndex = process.argv.indexOf("--source-store");
const outputIndex = process.argv.indexOf("--output-store");
const runIndex = process.argv.indexOf("--run-id");
if (sourceIndex < 0 || !process.argv[sourceIndex + 1] || outputIndex < 0 || !process.argv[outputIndex + 1]
  || runIndex < 0 || !/^\d{8}T\d{6}Z$/.test(process.argv[runIndex + 1] || "")) {
  throw new Error("GFS_INDEX_V5_ARGUMENTS_REQUIRED");
}
const expectedRunId = process.argv[runIndex + 1];
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

const latest = parseJson(await source.get(LATEST_144H_KEY), "GFS_INDEX_V5_LATEST_INVALID");
if (latest.runId !== expectedRunId) throw new Error("GFS_INDEX_V5_FIXED_RUN_MISMATCH");
const manifest = await verifiedObject(latest.manifest, "GFS_INDEX_V5_SOURCE_MANIFEST_INTEGRITY_FAILED");
const grid = await verifiedObject(manifest.grid, "GFS_INDEX_V5_SOURCE_GRID_INTEGRITY_FAILED", validateGridShard);
const forecasts = [];
for (const descriptor of manifest.forecasts) forecasts.push({ descriptor,
  value: await verifiedObject(descriptor, "GFS_INDEX_V5_SOURCE_FORECAST_INTEGRITY_FAILED",
    (value) => validateForecastShard(value, grid.grid.points.length)) });

const plan = buildCompactIndexObjects({ runId: latest.runId, sourceManifest: latest.manifest,
  sourceGrid: manifest.grid, grid, forecasts });
await rm(outputRoot, { recursive: true, force: true });
for (const item of plan.catalogObjects) {
  await output.put(item.key, item.body);
  const window = plan.manifest.windows.find((candidate) => candidate.id === item.windowId);
  validateIndexV5Catalog(parseJson(await output.get(item.key)), { runId: latest.runId,
    sourceManifest: latest.manifest, window, descriptor: item });
}
await output.put(plan.manifestObject.key, plan.manifestObject.body, { atomic: true });
validateIndexV5Manifest(parseJson(await output.get(plan.manifestObject.key)), { runId: latest.runId,
  sourceManifest: latest.manifest, sourceGrid: manifest.grid });
for (const item of plan.pointObjects) {
  await output.put(item.key, item.body);
  const segments = validateIndexV5PointMetadata(item.customMetadata, {
    pointObject: item, manifestDescriptor: plan.manifestDescriptor
  });
  for (const segment of segments) {
    const window = plan.manifest.windows.find((candidate) => candidate.id === segment.id);
    const bytes = item.body.subarray(segment.offset, segment.offset + segment.bytes);
    if (sha256(bytes) !== segment.sha256) throw new Error("GFS_INDEX_V5_POINT_RANGE_INTEGRITY_FAILED");
    validateIndexV5PointSegment(parseJson(bytes), { runId: latest.runId, sourceManifest: latest.manifest,
      indexManifest: plan.manifestDescriptor,
      point: { pointId: item.pointId, latitude: item.latitude, longitude: item.longitude }, window });
  }
}
const publishPlan = {
  schemaVersion: "weather.gfs.compact-index-publish-plan.v5",
  status: "COMPLETE",
  runId: latest.runId,
  sourceManifest: latest.manifest,
  manifest: plan.manifestDescriptor,
  objects: [
    ...plan.catalogObjects.map(({ key, bytes, sha256 }) => ({ key, bytes, sha256, contentType: "application/json" })),
    ...plan.pointObjects.map(({ key, bytes, sha256, customMetadata }) => ({
      key, bytes, sha256, contentType: "application/octet-stream", customMetadata
    })),
    { ...plan.manifestDescriptor, contentType: "application/json" }
  ]
};
const publishEncoded = encodeObject(publishPlan);
await output.put("publish-v5.json", publishEncoded.body, { atomic: true });
process.stdout.write(`${JSON.stringify({ status: "INDEX_V5_READY", runId: latest.runId,
  objectCount: plan.objectCount, catalogCount: plan.catalogObjects.length,
  pointBlobCount: plan.pointObjects.length, segmentCount: plan.pointObjects.length * 6,
  totalBytes: plan.totalBytes, manifestBytes: plan.manifestObject.bytes,
  manifestSha256: plan.manifestObject.sha256, publishPlanSha256: publishEncoded.sha256 })}\n`);
