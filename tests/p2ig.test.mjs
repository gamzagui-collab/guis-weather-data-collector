import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCoverage } from "../src/contracts.mjs";
import { buildRunObjects } from "../src/publisher.mjs";
import { listPublishedRuns } from "../src/noaa.mjs";
import { assessKmaGfsComparison } from "../src/adapter.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const hours48 = Array.from({ length: 48 }, (_, index) => index + 1);
const coverage48 = () => ({
  kind: "FORECAST_HOUR_SET",
  label: "48H",
  startForecastHour: 1,
  endForecastHour: 48,
  expectedForecastHours: hours48,
  collectedForecastHours: hours48,
  complete: true
});

function publicationFixture() {
  const modelRunAt = "2026-10-23T00:00:00Z";
  const at = (hour) => `2026-10-23T${String(hour).padStart(2, "0")}:00:00Z`;
  const frame = (hour, start) => ({
    messageIndex: 1, messageSha256: "a".repeat(64), sourceDataSha256: "b".repeat(64),
    sourceFile: `gfs-20261023-00-f${String(hour).padStart(3, "0")}.grib2`, modelRunAt,
    validAt: at(hour), forecastHour: hour, accumulationStart: at(start), accumulationEnd: at(hour),
    accumulationPeriod: `PT${hour - start}H`, stepRange: `${start}-${hour}`, sourceUnit: "kg m**-2", unit: "mm",
    conversion: "1 kg m-2 liquid-water equivalent = 1 mm", packing: { packingType: "grid_simple" },
    values: [{ pointId: 0, rawValue: "0", quantitativeValue: 0, status: "AVAILABLE" }],
    statistics: { availableCount: 1, missingCount: 0, zeroCount: 1, positiveCount: 0, minimum: 0, maximum: 0 }
  });
  return {
    schemaVersion: "weather.gfs.grid.v1", provider: "NOAA/NCEP", model: "GFS", broker: null,
    source: "NOAA/NCEP NOMADS", sourceUrl: "https://nomads.ncep.noaa.gov/",
    product: "GFS 0.25 degree GRIB2 surface APCP", variable: "precipitation", modelRunAt,
    publishedAt: null, fetchedAt: modelRunAt, sourceUnit: "kg m**-2", unit: "mm",
    area: { name: "Republic of Korea", bounds: { left: 124.5, right: 132, bottom: 32, top: 39.5 } },
    grid: { type: "regular_ll", Ni: 1, Nj: 1, resolutionDegrees: 0.25,
      points: [{ id: 0, latitude: 35.75, longitude: 127 }] },
    frames: [frame(1, 0), frame(3, 0), frame(6, 0), frame(12, 0)],
    duplicateMessagesRemoved: [], missingForecastHours: [], status: "AVAILABLE"
  };
}

test("48-hour coverage requires every unique forecast hour from f001 through f048", () => {
  assert.equal(validateCoverage(coverage48()).complete, true);
  assert.throws(() => validateCoverage({ ...coverage48(), collectedForecastHours: hours48.slice(0, -1) }), /COVERAGE_INCOMPLETE/);
  assert.throws(() => validateCoverage({ ...coverage48(), expectedForecastHours: [1, 3, 6, 12] }), /COVERAGE_INCOMPLETE|48H_COVERAGE_INVALID/);
});

test("coverage metadata is preserved in the manifest and latest pointer", () => {
  const data = publicationFixture();
  data.coverage = {
    kind: "FORECAST_HOUR_SET", label: "CUSTOM", startForecastHour: 1, endForecastHour: 12,
    expectedForecastHours: [1, 3, 6, 12], collectedForecastHours: [1, 3, 6, 12], complete: true
  };
  const plan = buildRunObjects(data);
  assert.deepEqual(plan.manifest.coverage, data.coverage);
  assert.deepEqual(plan.latest.coverage, data.coverage);
});

test("published run candidates are ordered and exclude future cycles", () => {
  const runs = listPublishedRuns(["20261022", "20261023"], {
    20261022: ["18"], 20261023: ["00", "06"]
  }, new Date("2026-10-23T03:00:00Z"));
  assert.deepEqual(runs.map((item) => item.modelRunAt), ["2026-10-22T18:00:00.000Z", "2026-10-23T00:00:00.000Z"]);
});

test("KMA and GFS comparison also requires identical accumulation boundaries", () => {
  const base = {
    status: "AVAILABLE", validAt: "2026-10-23T01:00:00Z", accumulationPeriod: "PT1H",
    accumulationStart: "2026-10-23T00:00:00Z", accumulationEnd: "2026-10-23T01:00:00Z",
    unit: "mm", quantitativeValue: 0
  };
  assert.equal(assessKmaGfsComparison(base, { ...base, quantitativeValue: 1 }).comparable, true);
  assert.equal(assessKmaGfsComparison(base, { ...base, accumulationStart: "2026-10-22T23:00:00Z" }).code,
    "ACCUMULATION_WINDOW_MISMATCH");
});

test("manual workflow enforces f001-f048, 55 requests, 15 MiB and remains unscheduled", async () => {
  const workflow = await readFile(join(here, "../.github/workflows/collect-gfs.yml"), "utf8");
  assert.match(workflow, /GFS_COLLECTION_MODE: "48H"/);
  assert.match(workflow, /GFS_FORECAST_HOURS: "1,2,3,[^"]*,48"/);
  assert.match(workflow, /GFS_MAX_REQUESTS: "55"/);
  assert.match(workflow, /GFS_MAX_DOWNLOAD_BYTES: "15728640"/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(workflow, /gfs-48h-\$\{\{ steps\.collect\.outputs\.model_run_key \}\}/);
  assert.match(workflow, /timeout-minutes: 30/);
  assert.doesNotMatch(workflow, /schedule:/);
  assert.doesNotMatch(workflow, /R2_|secrets\./);
});

test("verified combined workflow contains four active UTC schedule runs", async () => {
  const workflow = await readFile(join(here, "../.github/workflows/collect-gfs-automatic.yml"), "utf8");
  assert.match(workflow, /37 5,11,17,23 \* \* \*/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test("collector uses fatal coverage validation and sanitized collection evidence", async () => {
  const script = await readFile(join(here, "../scripts/collect-and-publish.mjs"), "utf8");
  const analyzer = await readFile(join(here, "../python/analyze_gfs_grid.py"), "utf8");
  assert.match(script, /GFS_NO_COMPLETE_48H_RUN_WITHIN_BUDGET/);
  assert.match(script, /--expected-forecast-hours/);
  assert.match(script, /weather\.gfs\.collection-evidence\.v2/);
  assert.match(script, /existingCollectedArtifact/);
  assert.match(script, /classifyDiscoveredRun/);
  assert.match(script, /GFS_MAX_DOWNLOAD_BYTES_INVALID/);
  assert.doesNotMatch(script, /ACCESS_KEY|SECRET_ACCESS_KEY/);
  assert.match(analyzer, /Incomplete forecast-hour coverage/);
  assert.match(analyzer, /list\(range\(1, 49\)\)/);
});

test("standalone simulation has no dependency on the Weather repository evidence directory", async () => {
  const source = await readFile(join(here, "../scripts/simulate-publication.mjs"), "utf8");
  assert.match(source, /GFS_SIMULATION_INPUT_REQUIRED/);
  assert.doesNotMatch(source, /\.local-tools|evidence-backup/);
});
