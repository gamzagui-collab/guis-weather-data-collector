import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildRetentionDryRun,
  compareSameRunOfficialContracts,
  evaluateIndependentHorizonStatus
} from "../src/cutover-readiness.mjs";
import { frameId as officialFrameId } from "../src/contracts.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));

function fixture(run = "2026-10-23T06:00:00.000Z", label = "48H") {
  const points = [{ id: 0, latitude: 35.75, longitude: 127 }, { id: 1, latitude: 36, longitude: 127 }];
  const forecasts = [];
  const shards = new Map();
  for (let hour = 1; hour <= 48; hour += 1) {
    const validAt = new Date(Date.parse(run) + hour * 3_600_000).toISOString();
    const frame = {
      messageIndex: 1, messageSha256: "a".repeat(64), sourceDataSha256: "b".repeat(64),
      sourceFile: `gfs.f${String(hour).padStart(3, "0")}`, modelRunAt: run, validAt, forecastHour: hour,
      accumulationStart: new Date(Date.parse(validAt) - 3_600_000).toISOString(), accumulationEnd: validAt,
      accumulationPeriod: "PT1H", stepRange: `${hour - 1}-${hour}`, sourceUnit: "kg m**-2", unit: "mm",
      conversion: "1 kg m-2 liquid-water equivalent = 1 mm", packing: { packingType: "grid_simple" },
      values: [{ pointId: 0, rawValue: "0", quantitativeValue: 0, status: "AVAILABLE" },
        { pointId: 1, rawValue: null, quantitativeValue: null, status: "MISSING" }],
      statistics: { availableCount: 1, missingCount: 1, zeroCount: 1, positiveCount: 0, minimum: 0, maximum: 0 }
    };
    const frameId = officialFrameId(frame);
    forecasts.push({ key: `${label}/${frameId}.json`, frameId, forecastHour: hour, validAt,
      accumulationStart: frame.accumulationStart, accumulationEnd: validAt, accumulationPeriod: "PT1H",
      sourceDataSha256: frame.sourceDataSha256, bytes: 1, sha256: "c".repeat(64) });
    shards.set(frameId, { schemaVersion: "weather.gfs.forecast-shard.v1", provider: "NOAA/NCEP", model: "GFS",
      broker: null, source: "NOAA/NCEP NOMADS", sourceUrl: "https://nomads.ncep.noaa.gov/", product: "GFS APCP",
      variable: "precipitation", modelRunAt: run, publishedAt: null, fetchedAt: label, sourceUnit: "kg m**-2",
      unit: "mm", area: { name: "Republic of Korea" }, frameId, frame, status: "AVAILABLE" });
  }
  const manifest = { status: "COMPLETE", runId: "20261023T060000Z", provider: "NOAA/NCEP", model: "GFS", broker: null,
    source: "NOAA/NCEP NOMADS", sourceUrl: "https://nomads.ncep.noaa.gov/", product: "GFS APCP", variable: "precipitation",
    modelRunAt: run, publishedAt: null, fetchedAt: label, sourceUnit: "kg m**-2", unit: "mm",
    area: { name: "Republic of Korea" }, forecasts };
  const grid = { schemaVersion: "weather.gfs.grid-shard.v1", provider: "NOAA/NCEP", model: "GFS", modelRunAt: run,
    grid: { type: "regular_ll", Ni: 2, Nj: 1, resolutionDegrees: 0.25, points }, status: "AVAILABLE" };
  return { manifest, grid, shards };
}

test("same model run preserves every official f001-f048 contract, grid, zero and missing", () => {
  const left = fixture(undefined, "48H");
  const right = fixture(undefined, "144H");
  const result = compareSameRunOfficialContracts({ manifest48: left.manifest, manifest144: right.manifest,
    grid48: left.grid, grid144: right.grid, shards48: left.shards, shards144: right.shards });
  assert.equal(result.status, "COMPATIBLE");
  assert.equal(result.contractCount, 48);
  assert.equal(result.valueCount, 96);
  assert.equal(result.zeroCount, 48);
  assert.equal(result.missingCount, 48);
  assert.equal(result.fetchedAtMayDiffer, true);
});

test("different model runs and changed raw values fail closed", () => {
  const left = fixture();
  const otherRun = fixture("2026-10-23T12:00:00.000Z", "144H");
  assert.throws(() => compareSameRunOfficialContracts({ manifest48: left.manifest, manifest144: otherRun.manifest,
    grid48: left.grid, grid144: otherRun.grid, shards48: left.shards, shards144: otherRun.shards }), /MODEL_RUN_MISMATCH/);
  const changed = fixture(undefined, "144H");
  changed.shards.values().next().value.frame.values[0].rawValue = "1";
  changed.shards.values().next().value.frame.values[0].quantitativeValue = 1;
  assert.throws(() => compareSameRunOfficialContracts({ manifest48: left.manifest, manifest144: changed.manifest,
    grid48: left.grid, grid144: changed.grid, shards48: left.shards, shards144: changed.shards }), /FRAME_MISMATCH/);
});

test("retention dry run protects both latest pointers and keeps namespaces separate", () => {
  const run = (namespace, hour, bytes = 100) => ({ namespace, runId: `2026102${hour}T060000Z`,
    modelRunAt: `2026-10-2${hour}T06:00:00.000Z`, objectCount: 10, bytes, complete: true });
  const result = buildRetentionDryRun({ runs: [run("48H", 4), run("48H", 3), run("48H", 2),
    run("144H", 4, 300), run("144H", 3, 300), run("144H", 2, 300), run("144H", 1, 300)],
    latest48RunId: "20261024T060000Z", latest144RunId: "20261024T060000Z", currentBytes: 1600 });
  assert.equal(result.status, "DRY_RUN_ONLY");
  assert.deepEqual(result.deleteCandidates.map((item) => `${item.namespace}:${item.runId}`).sort(),
    ["144H:20261021T060000Z", "48H:20261022T060000Z"]);
  assert.equal(result.deleteExecuted, false);
  assert.equal(result.lifecyclePolicyChanged, false);
});

test("retention blocks a latest pointer that is not a verified COMPLETE run", () => {
  assert.throws(() => buildRetentionDryRun({ runs: [{ namespace: "48H", runId: "20261024T060000Z",
    modelRunAt: "2026-10-24T06:00:00.000Z", objectCount: 1, bytes: 1, complete: false }],
    latest48RunId: "20261024T060000Z", latest144RunId: null, currentBytes: 1 }), /48H_LATEST_NOT_COMPLETE/);
});

test("48H and 144H operational evidence remains independently scoped", () => {
  const shared = { latest: { status: "AVAILABLE", modelRunAt: "2026-10-23T06:00:00Z", latestValidAt: "2026-10-29T06:00:00Z",
    coverage: { label: "144H" } }, publication: { lastPublishedAt: "2026-10-23T07:00:00Z" }, storageUsage: 100,
    now: new Date("2026-10-24T00:00:00Z") };
  const healthy = evaluateIndependentHorizonStatus({ horizon: "144H", ...shared,
    schedule: { lastScheduledAttemptAt: null, lastScheduledSuccessAt: null, consecutiveFailures: 0 } });
  const delayed = evaluateIndependentHorizonStatus({ horizon: "48H", ...shared,
    schedule: { lastScheduledAttemptAt: "2026-10-23T23:00:00Z", lastScheduledSuccessAt: "2026-10-23T22:00:00Z",
      failureCode: "COLLECTION_FAILED", consecutiveFailures: 1 } });
  assert.equal(healthy.horizon, "144H");
  assert.equal(healthy.status, "HEALTHY");
  assert.equal(delayed.horizon, "48H");
  assert.equal(delayed.status, "DELAYED");
});

test("prepared 144H contract remains bounded and secret-separated after Canary activation", async () => {
  const [prepared, active48, manual144, monitor144] = await Promise.all([
    readFile(new URL("../.github/workflows/collect-gfs-144h-canary.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/collect-gfs-automatic.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/collect-gfs-144h-manual.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/monitor-gfs-144h.yml", import.meta.url), "utf8")
  ]);
  assert.match(prepared, /schedule:/);
  assert.match(prepared, /GFS_COLLECTION_MODE: "144H"/);
  assert.match(prepared, /GFS_MAX_REQUESTS: "135"/);
  assert.match(prepared, /GFS_MAX_DOWNLOAD_BYTES: "20971520"/);
  assert.match(prepared, /timeout-minutes: 70/);
  const collect = prepared.split(/^  collect:/m)[1].split(/^  publish:/m)[0];
  assert.doesNotMatch(collect, /R2_ACCESS_KEY|R2_SECRET_ACCESS_KEY|secrets\.R2/);
  for (const source of [prepared, active48, manual144]) assert.match(source, /group: guis-weather-gfs-noaa-collection/);
  assert.match(monitor144, /inspect-r2-publication-144h\.mjs --execute/);
  assert.match(monitor144, /^  schedule:/m);
});

test("cutover audit is read-only, compares real descriptors and emits a retention dry run", async () => {
  const [script, workflow] = await Promise.all([
    readFile(new URL("../scripts/audit-gfs-cutover-r2.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/audit-gfs-cutover.yml", import.meta.url), "utf8")
  ]);
  assert.match(script, /compareSameRunOfficialContracts/);
  assert.match(script, /buildOperationalRetentionDryRun/);
  assert.match(script, /GFS_CUTOVER_SAME_MODEL_RUN_NOT_FOUND/);
  assert.doesNotMatch(script, /delete-object|put-object/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /schedule:|pull_request:/);
  assert.match(workflow, /retention-days: 3/);
});
