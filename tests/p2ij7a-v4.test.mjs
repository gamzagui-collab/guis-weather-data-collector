import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseJson, sha256 } from "../src/contracts.mjs";
import { GFS_144H_FORECAST_HOURS } from "../src/horizon-144.mjs";
import { buildRangeIndexObjects, validateIndexV4Manifest, validateIndexV4Segment,
  validateIndexV4Spatial } from "../src/indexes-v4.mjs";
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
  return { publication, index: buildRangeIndexObjects({ runId: publication.runId,
    sourceManifest: publication.latest.manifest, grid, forecasts }) };
}

test("v4 range index stores seven independently hashed segments per official point", () => {
  const { publication, index } = plan();
  assert.equal(index.manifest.indexVersion, "v4");
  assert.equal(index.pointObjects.length, 16);
  assert.equal(index.pointObjects[0].segments.length, 7);
  validateIndexV4Manifest(index.manifest, { runId: publication.runId, sourceManifest: publication.latest.manifest });
  const point = index.pointObjects[0];
  for (const segment of point.segments) {
    const body = point.body.subarray(segment.offset, segment.offset + segment.bytes);
    assert.equal(sha256(body), segment.sha256);
    validateIndexV4Segment(parseJson(body), { runId: publication.runId,
      sourceManifest: publication.latest.manifest, point: { pointId: 0 }, segment });
  }
});

test("v4 compatibility segment selects official f001-f048 without value derivation", () => {
  const { index } = plan();
  const point = index.pointObjects[1];
  const descriptor = point.segments.at(-1);
  const segment = parseJson(point.body.subarray(descriptor.offset, descriptor.offset + descriptor.bytes));
  assert.equal(segment.window.derivation, "OFFICIAL_144H_F001_F048_SELECTION_NO_VALUE_TRANSFORMATION");
  assert.equal(segment.rows.length, 49);
  assert.equal(segment.rows.every((row) => row[10] === "AVAILABLE" && row[9] === 0), true);
  assert.deepEqual(segment.rows.filter((row) => row[1] === 12).map((row) => row[5]).sort(), ["PT12H", "PT6H"]);
});

test("v4 spatial catalog anchors blob and range hashes while preserving exact coordinates", () => {
  const { publication, index } = plan();
  const item = index.spatialObjects[0];
  const spatial = parseJson(item.body);
  validateIndexV4Spatial(spatial, { runId: publication.runId,
    sourceManifest: publication.latest.manifest, descriptor: item });
  assert.equal(spatial.points[0].latitude, 33);
  assert.equal(spatial.points[0].longitude, 126);
  assert.equal(spatial.points[0].segments.at(-1).id, "compat-f001-f048");
});

test("manual v4 workflow is Preview-only NOAA-free deletion-free and schedule-free", async () => {
  const [workflow, publisher] = await Promise.all([
    readFile(new URL("../.github/workflows/backfill-gfs-144h-index-v4.yml", import.meta.url), "utf8"),
    readFile(new URL("../python/publish_index_v4.py", import.meta.url), "utf8")
  ]);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /schedule:|nomads|collect-gfs-144h\.mjs/i);
  assert.match(workflow, /guis-weather-gfs-preview/);
  assert.doesNotMatch(publisher, /delete_object|delete-object|Lifecycle/);
  assert.match(publisher, /R2_V4_IMMUTABLE_OBJECT_CONFLICT/);
});
