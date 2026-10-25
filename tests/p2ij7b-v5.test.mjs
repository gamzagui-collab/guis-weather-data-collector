import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseJson, sha256 } from "../src/contracts.mjs";
import { GFS_144H_FORECAST_HOURS } from "../src/horizon-144.mjs";
import { buildRangeIndexObjects } from "../src/indexes-v4.mjs";
import { buildCompactIndexObjects, validateIndexV5Catalog, validateIndexV5Manifest,
  validateIndexV5PointMetadata, validateIndexV5PointSegment } from "../src/indexes-v5.mjs";
import { buildRunObjects144 } from "../src/publisher-144.mjs";

const iso = (base, hours) => new Date(Date.parse(base) + hours * 3_600_000).toISOString();
function plan() {
  const modelRunAt = "2026-10-25T06:00:00.000Z";
  const points = Array.from({ length: 16 }, (_, id) => ({ id,
    latitude: 33 + Math.floor(id / 4) * 0.25, longitude: 126 + (id % 4) * 0.25 }));
  const frames = [];
  const add = (hour, period, suffix = "") => frames.push({
    frameId: `f${String(hour).padStart(3, "0")}-pt${period}h${suffix}`, messageIndex: 1,
    messageSha256: `${hour.toString(16).padStart(2, "0")}${"a".repeat(62)}`.slice(0, 64),
    sourceDataSha256: `${hour.toString(16).padStart(2, "0")}${"b".repeat(62)}`.slice(0, 64),
    sourceFile: `gfs-f${String(hour).padStart(3, "0")}.grib2`, modelRunAt, validAt: iso(modelRunAt, hour),
    forecastHour: hour, accumulationStart: iso(modelRunAt, hour - period), accumulationEnd: iso(modelRunAt, hour),
    accumulationPeriod: `PT${period}H`, stepRange: `${hour - period}-${hour}`, sourceUnit: "kg m**-2", unit: "mm",
    conversion: "1 kg m-2 liquid-water equivalent = 1 mm", packing: { packingType: "grid_simple" },
    values: points.map((point) => point.id === 0
      ? { pointId: 0, rawValue: null, quantitativeValue: null, status: "MISSING" }
      : { pointId: point.id, rawValue: point.id === 1 ? "0" : "0.25",
        quantitativeValue: point.id === 1 ? 0 : 0.25, status: "AVAILABLE" }),
    statistics: { availableCount: 15, missingCount: 1, zeroCount: 1, positiveCount: 14, minimum: 0, maximum: 0.25 }
  });
  for (const hour of GFS_144H_FORECAST_HOURS) {
    if (hour === 12) { add(12, 12); add(12, 6, "b"); } else add(hour, hour > 120 ? 3 : 1);
  }
  const publication = buildRunObjects144({ schemaVersion: "weather.gfs.grid.v1", provider: "NOAA/NCEP", model: "GFS",
    broker: null, source: "NOAA/NCEP NOMADS", sourceUrl: "https://nomads.ncep.noaa.gov/",
    product: "GFS 0.25 degree GRIB2 surface APCP", variable: "precipitation", modelRunAt, publishedAt: null,
    fetchedAt: "2026-10-25T07:00:00.000Z", sourceUnit: "kg m**-2", unit: "mm",
    area: { name: "Republic of Korea", bounds: { left: 126, right: 126.75, bottom: 33, top: 33.75 } },
    coverage: { kind: "FORECAST_HOUR_SET", label: "144H", horizonHours: 144, startForecastHour: 1,
      endForecastHour: 144, firstForecastHour: 1, lastForecastHour: 144,
      expectedForecastHours: [...GFS_144H_FORECAST_HOURS], collectedForecastHours: [...GFS_144H_FORECAST_HOURS],
      complete: true, sourceCadence: [{ startForecastHour: 1, endForecastHour: 120, intervalHours: 1 },
        { startForecastHour: 123, endForecastHour: 144, intervalHours: 3 }] },
    grid: { type: "regular_ll", Ni: 4, Nj: 4, resolutionDegrees: 0.25, points }, frames,
    duplicateMessagesRemoved: [], missingForecastHours: [], status: "AVAILABLE" });
  const grid = parseJson(publication.gridObject.body);
  const forecasts = publication.forecastObjects.map((item) => ({ descriptor: item, value: parseJson(item.body) }));
  const args = { runId: publication.runId, sourceManifest: publication.latest.manifest,
    sourceGrid: publication.manifest.grid, grid, forecasts };
  return { publication, v4: buildRangeIndexObjects({ runId: publication.runId,
    sourceManifest: publication.latest.manifest, grid, forecasts }), v5: buildCompactIndexObjects(args) };
}

test("v5 stores one shared contract catalog per official window and no duplicate 48H segment", () => {
  const { publication, v5 } = plan();
  assert.equal(v5.catalogObjects.length, 6);
  assert.equal(v5.pointObjects.length, 16);
  assert.equal(v5.pointObjects[0].segments.length, 6);
  assert.equal(v5.manifest.pointValues.compatibility48h.duplicateSegmentStored, false);
  assert.deepEqual(v5.manifest.pointValues.compatibility48h.windowIds, ["h001-h024", "h025-h048"]);
  validateIndexV5Manifest(v5.manifest, { runId: publication.runId,
    sourceManifest: publication.latest.manifest, sourceGrid: publication.manifest.grid });
  for (const [index, catalog] of v5.catalogObjects.entries()) {
    validateIndexV5Catalog(parseJson(catalog.body), { runId: publication.runId,
      sourceManifest: publication.latest.manifest, window: v5.manifest.windows[index], descriptor: catalog });
  }
});

test("v5 point blobs preserve missing, exact zero, positive values and multiple accumulation contracts", () => {
  const { publication, v5 } = plan();
  for (const point of v5.pointObjects.slice(0, 3)) {
    const segments = validateIndexV5PointMetadata(point.customMetadata, {
      pointObject: point, manifestDescriptor: v5.manifestDescriptor
    });
    for (const segment of segments) {
      const body = point.body.subarray(segment.offset, segment.offset + segment.bytes);
      assert.equal(sha256(body), segment.sha256);
      const value = parseJson(body);
      validateIndexV5PointSegment(value, { runId: publication.runId,
        sourceManifest: publication.latest.manifest, indexManifest: v5.manifestDescriptor,
        point: { pointId: point.pointId, latitude: point.latitude, longitude: point.longitude },
        window: v5.manifest.windows.find((window) => window.id === segment.id) });
      assert.equal(value.values.every((row) => row.length === 4), true);
      if (point.pointId === 0) assert.equal(value.values.every((row) => row[1] === null && row[3] === "MISSING"), true);
      if (point.pointId === 1) assert.equal(value.values.every((row) => row[1] === "0" && row[2] === 0), true);
    }
  }
  const firstCatalog = parseJson(v5.catalogObjects[0].body);
  assert.deepEqual(firstCatalog.contracts.filter((row) => row[1] === 12).map((row) => row[5]).sort(), ["PT12H", "PT6H"]);
});

test("v5 deterministic row-major routing rejects a changed grid or invalid point order", () => {
  const { v5 } = plan();
  assert.deepEqual(v5.manifest.grid, { type: "regular_ll", Ni: 4, Nj: 4, resolutionDegrees: 0.25,
    minLatitude: 33, minLongitude: 126, pointCount: 16, ordering: "ROW_MAJOR_DETERMINISTIC_POINT_ID" });
  const bad = plan();
  const grid = parseJson(bad.publication.gridObject.body);
  grid.grid.points[1].id = 99;
  assert.throws(() => buildCompactIndexObjects({ runId: bad.publication.runId,
    sourceManifest: bad.publication.latest.manifest, sourceGrid: bad.publication.manifest.grid,
    grid, forecasts: bad.publication.forecastObjects.map((item) => ({ descriptor: item, value: parseJson(item.body) })) }),
  /GFS_INDEX_V5_POINT_ID_NOT_DETERMINISTIC/);
});

test("v5 preserves official f120 to f123 cadence and reconstructs 48H from the first two windows only", () => {
  const { v5 } = plan();
  const lastCatalog = parseJson(v5.catalogObjects.at(-1).body);
  assert.deepEqual(lastCatalog.window.forecastHours, [123, 126, 129, 132, 135, 138, 141, 144]);
  assert.equal(v5.manifest.windows.slice(0, 2).reduce((sum, item) => sum + item.contractCount, 0), 49);
  assert.equal(v5.pointObjects[1].segments.slice(0, 2).reduce((sum, item) => sum + item.contractCount, 0), 49);
});

test("v5 compact catalog/value split materially reduces v4 storage", () => {
  const { v4, v5 } = plan();
  const v4Bytes = v4.manifestObject.bytes + v4.spatialObjects.reduce((sum, item) => sum + item.bytes, 0)
    + v4.pointObjects.reduce((sum, item) => sum + item.bytes, 0);
  assert.ok(v5.totalBytes < v4Bytes * 0.35, `${v5.totalBytes} should be below 35% of ${v4Bytes}`);
});

test("manual v5 workflow is fixed-run, Preview-only, NOAA-free, deletion-free and schedule-free", async () => {
  const [workflow, publisher] = await Promise.all([
    readFile(new URL("../.github/workflows/backfill-gfs-144h-index-v5.yml", import.meta.url), "utf8"),
    readFile(new URL("../python/publish_index_v5.py", import.meta.url), "utf8")
  ]);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /FIXED_RUN_ID/);
  assert.match(workflow, /--exclude "indexes\/\*"/);
  assert.doesNotMatch(workflow, /schedule:|nomads|collect-and-publish\.mjs/i);
  assert.match(workflow, /guis-weather-gfs-preview/);
  assert.doesNotMatch(publisher, /delete_object|delete-object|Lifecycle/);
  assert.match(publisher, /R2_V5_IMMUTABLE_OBJECT_CONFLICT/);
  assert.match(publisher, /SOFT_STOP_BYTES/);
});
