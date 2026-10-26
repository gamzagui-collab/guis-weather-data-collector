import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DownloadBudget, downloadFrame, fetchWithTransientRetry } from "../src/noaa.mjs";
import { parseJson } from "../src/contracts.mjs";
import { GFS_144H_FORECAST_HOURS } from "../src/horizon-144.mjs";
import { validateIndexV5Publication } from "../src/indexes-v5.mjs";
import { LocalObjectStore } from "../src/object-store.mjs";
import { LATEST_144H_KEY, publishDataset144, readLatestOperationalPublication144 } from "../src/publisher-144.mjs";
import { evaluateOperationalGate, requireOperationalActiveSince } from "../src/operational-gate.mjs";
import { evaluateScheduleMonitor } from "../src/schedule-monitor.mjs";
import { buildOperationalRetentionDryRun } from "../src/operational-retention.mjs";

function response(status, body = Buffer.alloc(0)) {
  return { status, headers: new Headers({ "content-length": String(body.byteLength) }),
    body: status === 200 ? [body] : { cancel: async () => {} } };
}

test("transient NOAA 503 uses bounded exponential backoff inside the hard request budget", async () => {
  const budget = new DownloadBudget({ maxRequests: 3, maxBytes: 20, minimumIntervalMs: 10_000 });
  const statuses = [503, 503, 200];
  const waits = [];
  let clock = 0;
  const result = await fetchWithTransientRetry({ url: "https://example.invalid", budget,
    fetchImpl: async () => response(statuses.shift(), Buffer.from("503")), retry: { maxRetries: 2, baseDelayMs: 10_000, maxDelayMs: 40_000 },
    sleep: async (ms) => { waits.push(ms); clock += ms; }, now: () => clock });
  assert.equal(result.status, 200);
  assert.deepEqual(waits, [10_000, 20_000]);
  assert.equal(budget.snapshot().requestsUsed, 3);
  assert.equal(budget.snapshot().bytesUsed, 6);
});

test("NOAA 403 and corrupt GRIB are terminal while a retry without budget fails closed", async () => {
  const forbidden = new DownloadBudget({ maxRequests: 3, maxBytes: 1, minimumIntervalMs: 0 });
  await assert.rejects(() => fetchWithTransientRetry({ url: "https://example.invalid", budget: forbidden,
    fetchImpl: async () => response(403), retry: { maxRetries: 2, baseDelayMs: 10_000, maxDelayMs: 40_000 },
    sleep: async () => {} }), /GFS_HTTP_403_FORBIDDEN/);
  assert.equal(forbidden.requestsUsed, 1);

  const limited = new DownloadBudget({ maxRequests: 1, maxBytes: 0, minimumIntervalMs: 0 });
  await assert.rejects(() => fetchWithTransientRetry({ url: "https://example.invalid", budget: limited,
    fetchImpl: async () => response(503), retry: { maxRetries: 2, baseDelayMs: 10_000, maxDelayMs: 40_000 },
    sleep: async () => {} }), /GFS_TRANSIENT_RETRY_BUDGET_EXHAUSTED/);
  assert.equal(limited.requestsUsed, 1);

  const corrupt = Buffer.from("not-a-grib-response");
  const corruptBudget = new DownloadBudget({ maxRequests: 3, maxBytes: 100, minimumIntervalMs: 0 });
  await assert.rejects(() => downloadFrame({ run: { runDate: "20261026", cycle: "06" }, forecastHour: 1,
    destination: join(tmpdir(), "must-not-be-created.grib2"), budget: corruptBudget,
    fetchImpl: async () => response(200, corrupt), retryOptions: { maxRetries: 2, baseDelayMs: 10_000, maxDelayMs: 40_000 } }),
  /GFS_GRIB_ENVELOPE_INVALID/);
  assert.equal(corruptBudget.requestsUsed, 1);
});

function dataset144() {
  const modelRunAt = "2026-10-26T06:00:00.000Z";
  const points = [{ id: 0, latitude: 35.75, longitude: 127 }];
  const frames = [];
  const add = (hour, period, suffix = "") => frames.push({
    frameId: `f${String(hour).padStart(3, "0")}-pt${period}h${suffix}`, messageIndex: 1,
    messageSha256: `${hour.toString(16).padStart(2, "0")}${"a".repeat(62)}`.slice(0, 64),
    sourceDataSha256: `${hour.toString(16).padStart(2, "0")}${"b".repeat(62)}`.slice(0, 64),
    sourceFile: `f${hour}.grib2`, modelRunAt,
    validAt: new Date(Date.parse(modelRunAt) + hour * 3_600_000).toISOString(), forecastHour: hour,
    accumulationStart: new Date(Date.parse(modelRunAt) + (hour - period) * 3_600_000).toISOString(),
    accumulationEnd: new Date(Date.parse(modelRunAt) + hour * 3_600_000).toISOString(),
    accumulationPeriod: `PT${period}H`, stepRange: `${hour - period}-${hour}`,
    sourceUnit: "kg m**-2", unit: "mm", conversion: "1 kg m-2 liquid-water equivalent = 1 mm",
    packing: { packingType: "grid_simple" },
    values: [{ pointId: 0, rawValue: hour === 1 ? "0" : null,
      quantitativeValue: hour === 1 ? 0 : null, status: hour === 1 ? "AVAILABLE" : "MISSING" }],
    statistics: { availableCount: hour === 1 ? 1 : 0, missingCount: hour === 1 ? 0 : 1,
      zeroCount: hour === 1 ? 1 : 0, positiveCount: 0, minimum: hour === 1 ? 0 : null, maximum: hour === 1 ? 0 : null }
  });
  for (const hour of GFS_144H_FORECAST_HOURS) {
    if (hour === 12) { add(hour, 12); add(hour, 6, "b"); }
    else add(hour, hour > 120 ? 3 : 1);
  }
  return { schemaVersion: "weather.gfs.grid.v1", provider: "NOAA/NCEP", model: "GFS", broker: null,
    source: "NOAA/NCEP NOMADS", sourceUrl: "https://nomads.ncep.noaa.gov/",
    product: "GFS 0.25 degree GRIB2 surface APCP", variable: "precipitation", modelRunAt,
    publishedAt: null, fetchedAt: "2026-10-26T07:00:00.000Z", sourceUnit: "kg m**-2", unit: "mm",
    area: { name: "Republic of Korea", bounds: { left: 127, right: 127, bottom: 35.75, top: 35.75 } },
    coverage: { kind: "FORECAST_HOUR_SET", label: "144H", horizonHours: 144, startForecastHour: 1,
      endForecastHour: 144, firstForecastHour: 1, lastForecastHour: 144,
      expectedForecastHours: [...GFS_144H_FORECAST_HOURS], collectedForecastHours: [...GFS_144H_FORECAST_HOURS],
      complete: true, sourceCadence: [{ startForecastHour: 1, endForecastHour: 120, intervalHours: 1 },
        { startForecastHour: 123, endForecastHour: 144, intervalHours: 3 }] },
    grid: { type: "regular_ll", Ni: 1, Nj: 1, resolutionDegrees: 0.25, points }, frames,
    duplicateMessagesRemoved: [], missingForecastHours: [], status: "AVAILABLE" };
}

test("new 144H publication becomes ready only after source and automatic v5 integrity pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "gfs-p2ij8-"));
  try {
    const store = new LocalObjectStore(root);
    const result = await publishDataset144(store, dataset144());
    assert.equal(result.v5ObjectCount, 8);
    const published = await readLatestOperationalPublication144(store);
    assert.equal(published.latest.publicReadiness.status, "COMPLETE");
    assert.equal(published.latest.publicReadiness.indexVersion, "v5");
    assert.equal(published.v5.pointValues.compatibility48h.duplicateSegmentStored, false);
    validateIndexV5Publication(published.publication, { runId: published.latest.runId,
      sourceManifest: published.latest.manifest, sourceGrid: published.manifest.grid,
      indexManifest: published.latest.indexes.v5.manifest });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("source and v5 partial publication cannot move latest and is recoverable idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "gfs-p2ij8-fail-"));
  try {
    const store = new LocalObjectStore(root);
    await assert.rejects(() => publishDataset144(store, dataset144(), {
      beforeLatestSwap: async () => { throw new Error("R2_NETWORK_INTERRUPTED"); }
    }), /R2_NETWORK_INTERRUPTED/);
    assert.equal(await store.tryGet(LATEST_144H_KEY), null);
    const recovered = await publishDataset144(store, dataset144());
    assert.equal(recovered.latest.publicReadiness.status, "COMPLETE");
    assert.equal((await readLatestOperationalPublication144(store)).latest.runId, recovered.runId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("operational schedule gate requires paid confirmation, approval, expired Canary and source-v5 baseline", () => {
  const blocked = evaluateOperationalGate({ paidConfirmed: false, cutoverApproved: true,
    canaryExpiresAt: "2026-10-27T06:45:00.000Z", canaryActive: true, currentPublicReady: true,
    operationalActiveSince: null,
    now: new Date("2026-10-26T00:00:00.000Z") });
  assert.deepEqual(blocked.reasons, ["WORKERS_PAID_NOT_CONFIRMED", "CANARY_STILL_ACTIVE",
    "GFS_144H_OPERATIONAL_ACTIVE_SINCE_MISSING"]);
  const ready = evaluateOperationalGate({ paidConfirmed: true, cutoverApproved: true,
    canaryExpiresAt: "2026-10-27T06:45:00.000Z", canaryActive: false, currentPublicReady: true,
    operationalActiveSince: "2026-10-27T07:00:00.000Z",
    now: new Date("2026-10-28T00:00:00.000Z") });
  assert.equal(ready.status, "READY");
  assert.equal(ready.operationalActiveSince, "2026-10-27T07:00:00.000Z");
});

test("operational activation time is required, UTC, after Canary, and not in the future", () => {
  const options = { now: new Date("2026-10-27T07:10:00.000Z"), canaryExpiresAt: "2026-10-27T06:45:00.000Z" };
  assert.throws(() => requireOperationalActiveSince({ ...options, value: null }),
    /GFS_144H_OPERATIONAL_ACTIVE_SINCE_MISSING/);
  assert.throws(() => requireOperationalActiveSince({ ...options, value: "not-a-time" }),
    /GFS_144H_OPERATIONAL_ACTIVE_SINCE_INVALID/);
  assert.throws(() => requireOperationalActiveSince({ ...options, value: "2026-10-27T16:00:00+09:00" }),
    /GFS_144H_OPERATIONAL_ACTIVE_SINCE_INVALID/);
  assert.throws(() => requireOperationalActiveSince({ ...options, value: "2026-10-27T06:45:00.000Z" }),
    /GFS_144H_OPERATIONAL_ACTIVE_SINCE_NOT_AFTER_CANARY/);
  assert.throws(() => requireOperationalActiveSince({ ...options, value: "2026-10-27T07:11:00.000Z" }),
    /GFS_144H_OPERATIONAL_ACTIVE_SINCE_FUTURE/);
});

test("first operational monitor ignores pre-activation slots but detects the first overdue active slot", () => {
  const schedule = {
    collectorSchedule: { hours: [7, 19], minute: 17 },
    monitorSchedule: { hours: [11, 23], minute: 17 },
    missingMs: 6 * 60 * 60 * 1000,
    activeSince: "2026-10-27T07:00:00.000Z"
  };
  const firstMonitor = {
    id: 1, event: "schedule", status: "in_progress", conclusion: null,
    created_at: "2026-10-27T11:20:00.000Z"
  };
  const first = evaluateScheduleMonitor({ ...schedule, now: "2026-10-27T11:20:00.000Z",
    collectorRuns: [{ id: 2, event: "schedule", status: "completed", conclusion: "success",
      created_at: "2026-10-27T07:20:00.000Z" }],
    monitorRuns: [firstMonitor], currentMonitorRun: firstMonitor });
  assert.equal(first.collectorScheduleExpected, false);
  assert.equal(first.monitorScheduleExpected, false);
  assert.ok(!first.reasons.some((reason) => reason.endsWith("_MISSING")));

  const overdue = evaluateScheduleMonitor({ ...schedule, now: "2026-10-27T14:00:00.000Z",
    collectorRuns: [], monitorRuns: [firstMonitor] });
  assert.equal(overdue.expectedCollectorSlot, "2026-10-27T07:17:00.000Z");
  assert.equal(overdue.collectorScheduleExpected, true);
  assert.ok(overdue.reasons.includes("COLLECTOR_SCHEDULE_EXECUTION_MISSING"));
});

test("operational retention is dry-run only, protects active v5 and uses two 144H runs per day", () => {
  const runs = [
    { namespace: "48H", runId: "20261026T180000Z", modelRunAt: "2026-10-26T18:00:00Z", complete: true,
      objectCount: 100, bytes: 20_000_000, storageBreakdown: { source: 15_000_000, v2: 5_000_000 } },
    ...["20261025T000000Z", "20261025T060000Z", "20261025T120000Z", "20261025T180000Z"].map((runId, index) => ({
      namespace: "144H", runId, modelRunAt: `2026-10-25T${String(index * 6).padStart(2, "0")}:00:00Z`,
      complete: true, objectCount: 1_100, bytes: 74_000_000,
      storageBreakdown: { source: 52_000_000, v3: index === 0 ? 2_000_000 : 0,
        v4: index === 0 ? 139_000_000 : 0, v5: 22_000_000 }
    }))
  ];
  const plan = buildOperationalRetentionDryRun({ runs, latest48RunId: "20261026T180000Z",
    latest144RunId: "20261025T180000Z", currentBytes: 483_067_693,
    rollback48RunId: "20261026T180000Z", canary144RunIds: ["20261025T060000Z"],
    activeV5RunIds: ["20261025T180000Z"] });
  assert.equal(plan.status, "OPERATIONAL_RETENTION_DRY_RUN_ONLY");
  assert.deepEqual(plan.policy.scheduledRunsPerDay, { "48H": 4, "144H": 2 });
  assert.equal(plan.projectedDailyGrowthBytes, 228_000_000);
  assert.equal(plan.storageComposition.experimentalBytes, 141_000_000);
  assert.equal(plan.deleteExecuted, false);
  assert.equal(plan.lifecyclePolicyChanged, false);
  assert.equal(plan.deleteCandidates.some((item) => item.runId === "20261025T180000Z"), false);
});

test("Paid operational workflows remain disabled, bounded and source-v5 aware", async () => {
  const [manual, operational, monitor, publisher, remotePublisher] = await Promise.all([
    readFile(new URL("../.github/workflows/collect-gfs-144h-manual.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/collect-gfs-144h-operational.yml.disabled", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/monitor-gfs-144h-operational.yml.disabled", import.meta.url), "utf8"),
    readFile(new URL("../src/publisher-144.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/publish-r2-144h.mjs", import.meta.url), "utf8")
  ]);
  assert.match(manual, /GFS_NOAA_TRANSIENT_RETRIES: "2"/);
  assert.match(manual, /GFS_MAX_REQUESTS: "135"/);
  assert.match(manual, /GFS_MAX_DOWNLOAD_BYTES: "20971520"/);
  assert.match(operational, /17 7,19 \* \* \*/);
  assert.match(operational, /WORKERS_PAID_CONFIRMED/);
  assert.match(operational, /CANARY_EXPIRES_AT/);
  assert.match(operational, /GFS_144H_OPERATIONAL_ACTIVE_SINCE: \$\{\{ vars\.GFS_144H_OPERATIONAL_ACTIVE_SINCE \}\}/);
  assert.match(monitor, /V5_PUBLIC_READINESS_NOT_COMPLETE/);
  assert.match(monitor, /requireOperationalActiveSince/);
  assert.match(monitor, /activeSince/);
  assert.match(monitor, /GFS_144H_OPERATIONAL_ACTIVE_SINCE: \$\{\{ vars\.GFS_144H_OPERATIONAL_ACTIVE_SINCE \}\}/);
  assert.match(publisher, /SOURCE_AND_V5_READY_TO_PUBLISH/);
  assert.match(publisher, /publicReadiness/);
  assert.match(remotePublisher, /v5_index_manifest_sha256=/);
});

test("operational caller cannot deadlock the reusable NOAA collector concurrency lock", async () => {
  const [manual, operational] = await Promise.all([
    readFile(new URL("../.github/workflows/collect-gfs-144h-manual.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/collect-gfs-144h-operational.yml.disabled", import.meta.url), "utf8")
  ]);
  assert.match(manual, /group: guis-weather-gfs-noaa-collection/);
  assert.match(operational, /group: guis-weather-gfs-144h-operational-orchestrator/);
  assert.doesNotMatch(operational, /group: guis-weather-gfs-noaa-collection/);
  assert.match(operational, /uses: \.\/\.github\/workflows\/collect-gfs-144h-manual\.yml/);
});
