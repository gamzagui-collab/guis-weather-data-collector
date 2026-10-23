import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicationArtifact144, verifyPublicationArtifact144 } from "../src/artifact-144.mjs";
import { parseJson, validateCoverage } from "../src/contracts.mjs";
import { GFS_144H_FORECAST_HOURS, GFS_144H_NAMESPACE, gfs144Windows } from "../src/horizon-144.mjs";
import { validateIndexV2Manifest, validateIndexV2Tile } from "../src/indexes-v2.mjs";
import { LocalObjectStore } from "../src/object-store.mjs";
import { LATEST_144H_KEY, buildRunObjects144, publishDataset144, readLatestPublication144 } from "../src/publisher-144.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));

function iso(modelRunAt, hours) {
  return new Date(Date.parse(modelRunAt) + hours * 3_600_000).toISOString();
}

function frame(modelRunAt, forecastHour, periodHours, points, suffix = "") {
  const validAt = iso(modelRunAt, forecastHour);
  const accumulationStart = iso(modelRunAt, forecastHour - periodHours);
  return {
    messageIndex: 1,
    messageSha256: `${forecastHour.toString(16).padStart(2, "0")}${"a".repeat(62)}`.slice(0, 64),
    sourceDataSha256: `${forecastHour.toString(16).padStart(2, "0")}${"b".repeat(62)}`.slice(0, 64),
    sourceFile: `gfs-20261023-00-f${String(forecastHour).padStart(3, "0")}.grib2`,
    modelRunAt,
    validAt,
    forecastHour,
    accumulationStart,
    accumulationEnd: validAt,
    accumulationPeriod: `PT${periodHours}H`,
    stepRange: `${forecastHour - periodHours}-${forecastHour}`,
    sourceUnit: "kg m**-2",
    unit: "mm",
    conversion: "1 kg m-2 liquid-water equivalent = 1 mm",
    packing: { packingType: "grid_simple" },
    values: points.map((point) => point.id === 0
      ? { pointId: point.id, rawValue: null, quantitativeValue: null, status: "MISSING" }
      : point.id === 1 ? { pointId: point.id, rawValue: "0", quantitativeValue: 0, status: "AVAILABLE" }
        : { pointId: point.id, rawValue: suffix ? "1.5" : "0.25", quantitativeValue: suffix ? 1.5 : 0.25, status: "AVAILABLE" }),
    statistics: { availableCount: points.length - 1, missingCount: 1, zeroCount: 1,
      positiveCount: points.length - 2, minimum: 0, maximum: suffix ? 1.5 : 0.25 }
  };
}

function dataset144() {
  const modelRunAt = "2026-10-23T00:00:00.000Z";
  const points = [];
  for (let row = 0; row < 9; row += 1) for (let column = 0; column < 9; column += 1) {
    points.push({ id: row * 9 + column, latitude: 32 + row * 0.25, longitude: 124.5 + column * 0.25 });
  }
  const frames = [];
  for (const hour of GFS_144H_FORECAST_HOURS) {
    if (hour === 12) {
      frames.push(frame(modelRunAt, hour, 12, points));
      frames.push(frame(modelRunAt, hour, 6, points, "second"));
    } else frames.push(frame(modelRunAt, hour, hour > 120 ? 3 : 1, points));
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
    fetchedAt: "2026-10-23T01:00:00.000Z",
    sourceUnit: "kg m**-2",
    unit: "mm",
    area: { name: "Republic of Korea", bounds: { left: 124.5, right: 132, bottom: 32, top: 39.5 } },
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
    grid: { type: "regular_ll", Ni: 9, Nj: 9, resolutionDegrees: 0.25, points },
    frames,
    duplicateMessagesRemoved: [],
    missingForecastHours: [],
    status: "AVAILABLE"
  };
}

test("official 144H forecast list contains 128 files and changes from f120 to f123", () => {
  assert.equal(GFS_144H_FORECAST_HOURS.length, 128);
  assert.deepEqual(GFS_144H_FORECAST_HOURS.slice(117, 123), [118, 119, 120, 123, 126, 129]);
  assert.equal(GFS_144H_FORECAST_HOURS.includes(121), false);
  assert.equal(GFS_144H_FORECAST_HOURS.includes(122), false);
  assert.equal(GFS_144H_FORECAST_HOURS.at(-1), 144);
  assert.equal(validateCoverage(dataset144().coverage).complete, true);
});

test("144H coverage fails closed for unsupported or missing forecast hours", () => {
  const missing = structuredClone(dataset144().coverage);
  missing.expectedForecastHours = missing.expectedForecastHours.filter((hour) => hour !== 123);
  missing.collectedForecastHours = [...missing.expectedForecastHours];
  assert.throws(() => validateCoverage(missing), /144H_COVERAGE_INVALID/);
  const invented = structuredClone(dataset144().coverage);
  invented.expectedForecastHours.splice(120, 0, 121);
  invented.collectedForecastHours = [...invented.expectedForecastHours];
  assert.throws(() => validateCoverage(invented), /144H_COVERAGE_INVALID/);
});

test("v2 index splits time into six 24-hour windows without inventing f121 or f122", () => {
  const plan = buildRunObjects144(dataset144());
  assert.equal(plan.indexPlan.manifest.schemaVersion, "weather.gfs.time-window-index-manifest.v2");
  assert.equal(plan.indexPlan.manifest.windows.length, 6);
  assert.equal(plan.indexPlan.tileObjects.length, 24);
  assert.deepEqual(plan.indexPlan.manifest.windows.at(-1).forecastHours, [123, 126, 129, 132, 135, 138, 141, 144]);
  assert.equal(plan.indexPlan.manifest.windows.at(-1).contractCount, 8);
  validateIndexV2Manifest(plan.indexPlan.manifest, { runId: plan.runId, sourceManifest: plan.latest.manifest });
  const descriptor = plan.indexPlan.tileObjects.find((item) => item.windowId === "h001-h024" && item.tileId === "r00-c00");
  const tile = parseJson(descriptor.body);
  validateIndexV2Tile(tile, { runId: plan.runId, sourceManifest: plan.latest.manifest, descriptor });
  assert.deepEqual(tile.contracts.filter((item) => item.forecastHour === 12).map((item) => item.accumulationPeriod).sort(), ["PT12H", "PT6H"]);
  assert.equal(tile.points.find((point) => point.pointId === 0).values.every((value) => value.status === "MISSING"), true);
  assert.equal(tile.points.find((point) => point.pointId === 1).values.every((value) => value.quantitativeValue === 0), true);
});

test("144H publisher writes only its namespace and preserves root 48H latest", async () => {
  const root = await mkdtemp(join(tmpdir(), "gfs-144h-publish-"));
  const store = new LocalObjectStore(root);
  const original48 = Buffer.from('{"runId":"48H-PRESERVED"}\n');
  await store.put("latest.json", original48);
  try {
    const result = await publishDataset144(store, dataset144());
    const keys = await store.list();
    assert.equal((await store.get("latest.json")).equals(original48), true);
    assert.equal(keys.filter((key) => key !== "latest.json").every((key) => key.startsWith(`${GFS_144H_NAMESPACE}/`)), true);
    assert.equal(result.latest.coverage.expectedForecastHours.length, 128);
    const publication = await readLatestPublication144(store);
    assert.equal(publication.index.windows.length, 6);
    assert.equal(LATEST_144H_KEY, "horizons/144h/latest.json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("144H artifact preserves provenance hashes and every object stays namespaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "gfs-144h-store-"));
  const artifactRoot = await mkdtemp(join(tmpdir(), "gfs-144h-artifact-"));
  const store = new LocalObjectStore(root);
  try {
    await publishDataset144(store, dataset144());
    const provenance = { repository: "gamzagui-collab/guis-weather-data-collector", ref: "main",
      commit: "1".repeat(40), workflowRunId: "123456" };
    const metadata = await createPublicationArtifact144({ storeRoot: root, artifactRoot, provenance });
    assert.equal(metadata.coverage.expectedForecastHours.length, 128);
    assert.equal(metadata.objects.every((item) => item.key.startsWith("horizons/144h/")), true);
    const verified = await verifyPublicationArtifact144({ artifactRoot, expected: provenance });
    assert.equal(verified.latest.dataMode, "OPERATIONAL_144H");
    assert.deepEqual(verified.manifest.forecasts.filter((item) => item.forecastHour === 12)
      .map((item) => item.accumulationPeriod).sort(), ["PT12H", "PT6H"]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("manual 144H workflow is bounded, unscheduled, namespace-specific and keeps R2 secrets out of collect", async () => {
  const workflow = await readFile(join(here, "../.github/workflows/collect-gfs-144h-manual.yml"), "utf8");
  const automatic48 = await readFile(join(here, "../.github/workflows/collect-gfs-automatic.yml"), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /schedule:/);
  assert.match(workflow, /GFS_COLLECTION_MODE: "144H"/);
  assert.match(workflow, /GFS_MAX_REQUESTS: "135"/);
  assert.match(workflow, /GFS_MAX_DOWNLOAD_BYTES: "20971520"/);
  assert.match(workflow, /timeout-minutes: 60/);
  assert.match(workflow, /publish-r2-144h\.mjs/);
  const collectSection = workflow.split(/^  collect:/m)[1].split(/^  publish:/m)[0];
  assert.doesNotMatch(collectSection, /R2_ACCESS_KEY|R2_SECRET_ACCESS_KEY|secrets\.R2/);
  assert.match(automatic48, /37 5,11,17,23 \* \* \*/);
  assert.match(automatic48, /GFS_COLLECTION_MODE: "48H"/);
  assert.match(automatic48, /GFS_FORECAST_HOURS: "1,2,3,[^"]*,48"/);
});

test("144H remote scripts are namespace-locked and never delete R2 objects", async () => {
  const [publisher, inspector] = await Promise.all([
    readFile(join(here, "../scripts/publish-r2-144h.mjs"), "utf8"),
    readFile(join(here, "../scripts/inspect-r2-publication-144h.mjs"), "utf8")
  ]);
  assert.match(publisher, /GFS_144H_NAMESPACE/);
  assert.match(publisher, /R2_144H_NAMESPACE_ESCAPE/);
  assert.doesNotMatch(publisher, /delete-object/);
  assert.doesNotMatch(inspector, /delete-object/);
  assert.match(inspector, /evaluateStorageProtection/);
});
