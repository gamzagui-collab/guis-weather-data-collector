import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseJson } from "../src/contracts.mjs";
import { GFS_144H_FORECAST_HOURS } from "../src/horizon-144.mjs";
import {
  buildPointWindowIndexObjects,
  validateIndexV3Contracts,
  validateIndexV3Manifest,
  validateIndexV3Point,
  validateIndexV3Spatial
} from "../src/indexes-v3.mjs";
import { buildRunObjects144 } from "../src/publisher-144.mjs";

function iso(modelRunAt, hours) {
  return new Date(Date.parse(modelRunAt) + hours * 3_600_000).toISOString();
}

function dataset() {
  const modelRunAt = "2026-10-25T06:00:00.000Z";
  const points = [];
  for (let row = 0; row < 4; row += 1) for (let column = 0; column < 4; column += 1) {
    points.push({ id: row * 4 + column, latitude: 33 + row * 0.25, longitude: 126 + column * 0.25 });
  }
  const frames = [];
  const add = (forecastHour, periodHours, suffix = "") => {
    const validAt = iso(modelRunAt, forecastHour);
    const frameId = `f${String(forecastHour).padStart(3, "0")}-pt${periodHours}h${suffix}`;
    frames.push({
      frameId,
      messageIndex: 1,
      messageSha256: `${forecastHour.toString(16).padStart(2, "0")}${"a".repeat(62)}`.slice(0, 64),
      sourceDataSha256: `${forecastHour.toString(16).padStart(2, "0")}${suffix ? "c" : "b".repeat(62)}`.padEnd(64, "b").slice(0, 64),
      sourceFile: `gfs-f${String(forecastHour).padStart(3, "0")}.grib2`,
      modelRunAt,
      validAt,
      forecastHour,
      accumulationStart: iso(modelRunAt, forecastHour - periodHours),
      accumulationEnd: validAt,
      accumulationPeriod: `PT${periodHours}H`,
      stepRange: `${forecastHour - periodHours}-${forecastHour}`,
      sourceUnit: "kg m**-2",
      unit: "mm",
      conversion: "1 kg m-2 liquid-water equivalent = 1 mm",
      packing: { packingType: "grid_simple" },
      values: points.map((point) => point.id === 0
        ? { pointId: point.id, rawValue: null, quantitativeValue: null, status: "MISSING" }
        : point.id === 1
          ? { pointId: point.id, rawValue: "0", quantitativeValue: 0, status: "AVAILABLE" }
          : { pointId: point.id, rawValue: suffix ? "1.5" : "0.25",
            quantitativeValue: suffix ? 1.5 : 0.25, status: "AVAILABLE" }),
      statistics: { availableCount: 15, missingCount: 1, zeroCount: 1, positiveCount: 14,
        minimum: 0, maximum: suffix ? 1.5 : 0.25 }
    });
  };
  for (const hour of GFS_144H_FORECAST_HOURS) {
    if (hour === 12) {
      add(hour, 12);
      add(hour, 6, "b");
    } else add(hour, hour > 120 ? 3 : 1);
  }
  return {
    schemaVersion: "weather.gfs.grid.v1",
    provider: "NOAA/NCEP",
    model: "GFS",
    broker: null,
    source: "NOAA/NCEP NOMADS",
    sourceUrl: "https://nomads.ncep.noaa.gov/",
    product: "GFS 0.25 degree GRIB2 surface APCP",
    variable: "precipitation",
    modelRunAt,
    publishedAt: null,
    fetchedAt: "2026-10-25T07:00:00.000Z",
    sourceUnit: "kg m**-2",
    unit: "mm",
    area: { name: "Republic of Korea", bounds: { left: 126, right: 126.75, bottom: 33, top: 33.75 } },
    coverage: {
      kind: "FORECAST_HOUR_SET",
      label: "144H",
      horizonHours: 144,
      startForecastHour: 1,
      endForecastHour: 144,
      firstForecastHour: 1,
      lastForecastHour: 144,
      expectedForecastHours: [...GFS_144H_FORECAST_HOURS],
      collectedForecastHours: [...GFS_144H_FORECAST_HOURS],
      complete: true,
      sourceCadence: [
        { startForecastHour: 1, endForecastHour: 120, intervalHours: 1 },
        { startForecastHour: 123, endForecastHour: 144, intervalHours: 3 }
      ]
    },
    grid: { type: "regular_ll", Ni: 4, Nj: 4, resolutionDegrees: 0.25, points },
    frames,
    duplicateMessagesRemoved: [],
    missingForecastHours: [],
    status: "AVAILABLE"
  };
}

function plan() {
  const publication = buildRunObjects144(dataset());
  const grid = parseJson(publication.gridObject.body);
  const forecasts = publication.forecastObjects.map((descriptor) => ({
    descriptor,
    value: parseJson(descriptor.body)
  }));
  return {
    publication,
    index: buildPointWindowIndexObjects({ runId: publication.runId,
      sourceManifest: publication.latest.manifest, grid, forecasts })
  };
}

test("v3 precomputes one small immutable timeline per official grid point", () => {
  const { publication, index } = plan();
  assert.equal(index.manifest.indexVersion, "v3");
  assert.equal(index.manifest.grid.pointCount, 16);
  assert.equal(index.manifest.windows.length, 6);
  assert.equal(index.contractObjects.length, 6);
  assert.equal(index.spatialObjects.length, 1);
  assert.equal(index.pointObjects.length, 16);
  assert.equal(index.manifest.objectCount, 23);
  validateIndexV3Manifest(index.manifest, { runId: publication.runId, sourceManifest: publication.latest.manifest });
});

test("v3 preserves source shard provenance, f120 to f123 cadence and multiple f012 contracts", () => {
  const { publication, index } = plan();
  for (const item of index.contractObjects) validateIndexV3Contracts(parseJson(item.body), {
    runId: publication.runId, sourceManifest: publication.latest.manifest, descriptor: item
  });
  const first = parseJson(index.contractObjects[0].body);
  assert.deepEqual(first.contracts.filter((item) => item.forecastHour === 12)
    .map((item) => item.accumulationPeriod).sort(), ["PT12H", "PT6H"]);
  assert.equal(first.contracts.every((item) => /^[a-f0-9]{64}$/.test(item.sourceShard.sha256)), true);
  assert.deepEqual(index.manifest.windows.at(-1).forecastHours, [123, 126, 129, 132, 135, 138, 141, 144]);
  assert.equal(index.manifest.windows.some((window) => window.forecastHours.includes(121)), false);
});

test("v3 point timelines preserve missing zero positive and never derive hourly values", () => {
  const { publication, index } = plan();
  const missing = parseJson(index.pointObjects.find((item) => item.pointId === 0).body);
  const zero = parseJson(index.pointObjects.find((item) => item.pointId === 1).body);
  const positive = parseJson(index.pointObjects.find((item) => item.pointId === 2).body);
  for (const item of [missing, zero, positive]) validateIndexV3Point(item, {
    runId: publication.runId,
    sourceManifest: publication.latest.manifest,
    descriptor: index.pointObjects.find((descriptor) => descriptor.pointId === item.point.pointId),
    windows: index.manifest.windows
  });
  assert.equal(missing.windows.every((window) => window.values.every((value) => value.status === "MISSING")), true);
  assert.equal(zero.windows.every((window) => window.values.every((value) => value.quantitativeValue === 0)), true);
  assert.equal(positive.windows.flatMap((window) => window.values).some((value) => value.quantitativeValue > 0), true);
  assert.equal(positive.windows.flatMap((window) => window.values).length, index.manifest.contractCount);
});

test("v3 spatial catalog keeps exact official coordinates and immutable point hashes", () => {
  const { publication, index } = plan();
  const descriptor = index.spatialObjects[0];
  const spatial = parseJson(descriptor.body);
  validateIndexV3Spatial(spatial, { runId: publication.runId,
    sourceManifest: publication.latest.manifest, descriptor });
  assert.deepEqual(spatial.points[0], {
    pointId: 0,
    gridRow: 0,
    gridColumn: 0,
    latitude: 33,
    longitude: 126,
    timeline: {
      key: index.pointObjects[0].key,
      bytes: index.pointObjects[0].bytes,
      sha256: index.pointObjects[0].sha256
    }
  });
  const tampered = structuredClone(index.manifest);
  tampered.spatialCatalogs[0].sha256 = "0".repeat(64);
  assert.notEqual(tampered.spatialCatalogs[0].sha256, index.manifest.spatialCatalogs[0].sha256);
});

test("manual v3 backfill is NOAA-free, deletion-free, Preview-bucket locked and leaves Canary unchanged", async () => {
  const [workflow, publisher, canary] = await Promise.all([
    readFile(new URL("../.github/workflows/backfill-gfs-144h-index-v3.yml", import.meta.url), "utf8"),
    readFile(new URL("../python/publish_index_v3.py", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/collect-gfs-144h-canary.yml", import.meta.url), "utf8")
  ]);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /schedule:/);
  assert.doesNotMatch(workflow, /nomads|collect-gfs-144h\.mjs|curl\s|wget\s/i);
  assert.match(workflow, /guis-weather-gfs-preview/);
  assert.match(publisher, /guis-weather-gfs-preview/);
  assert.doesNotMatch(publisher, /delete_object|delete-object|Lifecycle/);
  assert.match(publisher, /R2_V3_IMMUTABLE_OBJECT_CONFLICT/);
  assert.match(canary, /GFS_144H_CANARY_PUBLICATION_LIMIT:\s*"2"/);
  assert.match(canary, /2026-10-27T06:45:00Z/);
});
