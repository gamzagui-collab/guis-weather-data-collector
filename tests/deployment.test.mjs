import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readGfsForLocation, assessKmaGfsComparison, isHeatmapEligible } from "../src/adapter.mjs";
import { buildRunObjects, publishDataset, readLatestPublication } from "../src/publisher.mjs";
import { LocalObjectStore } from "../src/object-store.mjs";
import { applyRetention } from "../src/retention.mjs";
import { runCollectorWorkflow } from "../src/workflow.mjs";
import { buildFilterUrl, buildRawIndexUrl, DownloadBudget, parseCycles, parseRunDates, selectLatestRun, verifyRunComplete } from "../src/noaa.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const hash = (value) => value.repeat(64);

export function fixture(modelRunAt = "2026-10-22T06:00:00Z") {
  const run = new Date(modelRunAt);
  const at = (hours) => new Date(run.valueOf() + hours * 3_600_000).toISOString().replace(".000Z", "Z");
  const points = [
    { id: 0, latitude: 33.5, longitude: 126.5 },
    { id: 1, latitude: 35.75, longitude: 127 },
    { id: 2, latitude: 35.25, longitude: 129 },
    { id: 3, latitude: 37.5, longitude: 127 }
  ];
  const values = [
    { pointId: 0, rawValue: "0", quantitativeValue: 0, status: "AVAILABLE" },
    { pointId: 1, rawValue: "0.5", quantitativeValue: 0.5, status: "AVAILABLE" },
    { pointId: 2, rawValue: null, quantitativeValue: null, status: "MISSING" },
    { pointId: 3, rawValue: "2", quantitativeValue: 2, status: "AVAILABLE" }
  ];
  const frame = (forecastHour, start, end, period, sourceHash) => ({
    messageIndex: 1,
    messageSha256: hash("b"),
    sourceDataSha256: sourceHash,
    sourceFile: `f${String(forecastHour).padStart(3, "0")}.grib2`,
    modelRunAt,
    validAt: at(end),
    forecastHour,
    accumulationStart: at(start),
    accumulationEnd: at(end),
    accumulationPeriod: period,
    stepRange: `${start}-${end}`,
    sourceUnit: "kg m**-2",
    unit: "mm",
    conversion: "1 kg m-2 liquid-water equivalent = 1 mm",
    packing: { packingType: "grid_simple", bitsPerValue: 4 },
    values: structuredClone(values),
    statistics: { availableCount: 3, missingCount: 1, zeroCount: 1, positiveCount: 2, minimum: 0, maximum: 2 }
  });
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
    fetchedAt: at(0),
    sourceUnit: "kg m**-2",
    unit: "mm",
    area: { name: "Republic of Korea", bounds: { left: 124.5, right: 132, bottom: 32, top: 39.5 } },
    grid: { type: "regular_ll", Ni: 4, Nj: 1, resolutionDegrees: 0.25, points },
    frames: [
      frame(1, 0, 1, "PT1H", hash("a")),
      frame(3, 0, 3, "PT3H", hash("e")),
      frame(6, 0, 6, "PT6H", hash("f")),
      frame(12, 0, 12, "PT12H", hash("c")),
      frame(12, 6, 12, "PT6H", hash("d"))
    ],
    duplicateMessagesRemoved: [],
    missingForecastHours: [],
    status: "AVAILABLE"
  };
}

async function temporaryStore(prefix = "gfs-p2id-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return { root, store: new LocalObjectStore(root), close: () => rm(root, { recursive: true, force: true }) };
}

test("run is sharded into the specified R2 layout and f012 contracts remain independent", () => {
  const plan = buildRunObjects(fixture());
  assert.equal(plan.gridObject.key, `runs/${plan.runId}/grid.json`);
  assert.equal(plan.manifestObject.key, `runs/${plan.runId}/manifest.json`);
  assert.equal(plan.forecastObjects.length, 5);
  const twelve = plan.forecastObjects.filter((item) => item.forecastHour === 12);
  assert.equal(twelve.length, 2);
  assert.notEqual(twelve[0].frameId, twelve[1].frameId);
  assert.deepEqual(new Set(twelve.map((item) => item.accumulationPeriod)), new Set(["PT12H", "PT6H"]));
});

test("publisher verifies shards and writes latest.json last", async () => {
  const holder = await temporaryStore();
  const writes = [];
  const tracking = new Proxy(holder.store, {
    get(target, property) {
      if (property === "put") return async (key, ...args) => { writes.push(key); return target.put(key, ...args); };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  try {
    await publishDataset(tracking, fixture());
    assert.equal(writes.at(-1), "latest.json");
    const result = await readLatestPublication(holder.store);
    assert.equal(result.manifest.objectCount, 6);
  } finally { await holder.close(); }
});

test("a failure before pointer swap preserves previous latest and records failure", async () => {
  const holder = await temporaryStore();
  try {
    await publishDataset(holder.store, fixture());
    await assert.rejects(() => publishDataset(holder.store, fixture("2026-10-22T12:00:00Z"), {
      beforeLatestSwap() { throw new Error("SIMULATED_PUBLISH_FAILURE"); }
    }), /SIMULATED_PUBLISH_FAILURE/);
    const { latest } = await readLatestPublication(holder.store);
    assert.equal(latest.modelRunAt, "2026-10-22T06:00:00Z");
    const status = JSON.parse(await holder.store.get("status/collector.json"));
    assert.equal(status.status, "FAILED");
    assert.equal(status.failureCode, "SIMULATED_PUBLISH_FAILURE");
  } finally { await holder.close(); }
});

test("tampered immutable object is rejected instead of served", async () => {
  const holder = await temporaryStore();
  try {
    const result = await publishDataset(holder.store, fixture());
    await holder.store.put(result.latest.manifest.key, "{}\n");
    await assert.rejects(() => readLatestPublication(holder.store), /INTEGRITY_FAILED/);
  } finally { await holder.close(); }
});

test("retention keeps latest and one previous successful run", async () => {
  const holder = await temporaryStore();
  try {
    await publishDataset(holder.store, fixture("2026-10-22T00:00:00Z"));
    await publishDataset(holder.store, fixture("2026-10-22T06:00:00Z"));
    await publishDataset(holder.store, fixture("2026-10-22T12:00:00Z"));
    const result = await applyRetention(holder.store, { keepSuccessful: 2, now: new Date("2026-10-23T00:00:00Z") });
    assert.equal(result.keptRuns.length, 2);
    assert.equal(result.deletedRuns.length, 1);
    const { latest } = await readLatestPublication(holder.store);
    assert.equal(latest.modelRunAt, "2026-10-22T12:00:00Z");
  } finally { await holder.close(); }
});

test("recent incomplete staging run observes grace period and can later be pruned", async () => {
  const holder = await temporaryStore();
  try {
    await publishDataset(holder.store, fixture());
    await holder.store.put("runs/incomplete/grid.json", "{}\n");
    const protectedResult = await applyRetention(holder.store, { incompleteGraceMs: 86_400_000, now: new Date() });
    assert.equal(protectedResult.deletedRuns.includes("incomplete"), false);
    const pruned = await applyRetention(holder.store, { incompleteGraceMs: 0, now: new Date(Date.now() + 1_000) });
    assert.equal(pruned.deletedRuns.includes("incomplete"), true);
  } finally { await holder.close(); }
});

test("disabled Weather adapter does not touch storage", async () => {
  const result = await readGfsForLocation(null, { enabled: false, latitude: 35, longitude: 127 });
  assert.deepEqual(result, { status: "DISABLED", provider: "NOAA/NCEP", model: "GFS", values: [] });
});

test("adapter selects official nearest grids for multiple Korean sites without interpolation", async () => {
  const holder = await temporaryStore();
  try {
    await publishDataset(holder.store, fixture());
    const sites = [[33.4996, 126.5312], [35.8036, 126.8809], [35.1796, 129.0756], [37.5665, 126.978]];
    for (const [latitude, longitude] of sites) {
      const result = await readGfsForLocation(holder.store, { enabled: true, latitude, longitude, now: new Date("2026-10-22T12:00:00Z") });
      assert.equal(result.status, "AVAILABLE");
      assert.equal(result.values.length, 5);
      assert.ok(result.gridPoint.distanceKm >= 0);
      assert.equal(result.values[0].spatialProcessing, "NEAREST_GRID_POINT_NO_INTERPOLATION");
    }
  } finally { await holder.close(); }
});

test("adapter reports STALE and retains last collection failure details", async () => {
  const holder = await temporaryStore();
  try {
    await publishDataset(holder.store, fixture());
    await assert.rejects(() => publishDataset(holder.store, fixture("2026-10-22T12:00:00Z"), {
      beforeLatestSwap() { throw new Error("DOWNLOAD_FAILED"); }
    }));
    const result = await readGfsForLocation(holder.store, { enabled: true, latitude: 35.8, longitude: 126.9, now: new Date("2026-10-24T00:00:00Z") });
    assert.equal(result.status, "STALE");
    assert.equal(result.modelRunAt, "2026-10-22T06:00:00Z");
    assert.equal(result.collection.failureCode, "DOWNLOAD_FAILED");
  } finally { await holder.close(); }
});

test("actual zero, missing, PT6H and PT12H remain distinct in adapter output", async () => {
  const holder = await temporaryStore();
  try {
    await publishDataset(holder.store, fixture());
    const zero = await readGfsForLocation(holder.store, { enabled: true, latitude: 33.5, longitude: 126.5, now: new Date("2026-10-22T12:00:00Z") });
    assert.equal(zero.values[0].quantitativeValue, 0);
    const missing = await readGfsForLocation(holder.store, { enabled: true, latitude: 35.25, longitude: 129, now: new Date("2026-10-22T12:00:00Z") });
    assert.equal(missing.values[0].status, "MISSING");
    assert.equal(missing.values[0].quantitativeValue, null);
    assert.deepEqual(new Set(zero.values.filter((value) => value.frameId.startsWith("f012-")).map((value) => value.accumulationPeriod)), new Set(["PT12H", "PT6H"]));
  } finally { await holder.close(); }
});

test("KMA comparison and Heatmap accept only same-time verified PT1H mm", () => {
  const base = {
    status: "AVAILABLE", validAt: "2026-10-22T07:00:00Z", accumulationPeriod: "PT1H",
    accumulationStart: "2026-10-22T06:00:00Z", accumulationEnd: "2026-10-22T07:00:00Z",
    unit: "mm", quantitativeValue: 0
  };
  assert.equal(assessKmaGfsComparison(base, { ...base, quantitativeValue: 1 }).comparable, true);
  assert.equal(assessKmaGfsComparison(base, { ...base, accumulationPeriod: "PT3H" }).code, "INCOMPATIBLE_ACCUMULATION");
  assert.equal(assessKmaGfsComparison(base, { ...base, validAt: "2026-10-22T08:00:00Z" }).code, "VALID_TIME_MISMATCH");
  assert.equal(isHeatmapEligible(base), true);
  assert.equal(isHeatmapEligible({ ...base, status: "MISSING", quantitativeValue: null }), false);
  assert.equal(isHeatmapEligible({ ...base, accumulationPeriod: "PT6H" }), false);
});

test("workflow skips a previously published run without collecting again", async () => {
  const holder = await temporaryStore();
  try {
    await publishDataset(holder.store, fixture());
    let collected = 0;
    const result = await runCollectorWorkflow({
      store: holder.store,
      discoverRun: async () => ({ modelRunAt: "2026-10-22T06:00:00Z" }),
      collectDataset: async () => { collected += 1; return fixture(); }
    });
    assert.equal(result.status, "UNCHANGED");
    assert.equal(collected, 0);
  } finally { await holder.close(); }
});

test("official URL is Korea-only surface APCP and request budget blocks overrun", async () => {
  const url = buildFilterUrl({ runDate: "20261022", cycle: "06", forecastHour: 12 });
  assert.equal(url.origin, "https://nomads.ncep.noaa.gov");
  assert.equal(url.searchParams.get("var_APCP"), "on");
  assert.equal(url.searchParams.get("leftlon"), "124.5");
  const budget = new DownloadBudget({ maxRequests: 1, maxBytes: 10, minimumIntervalMs: 0 });
  await budget.beforeRequest();
  await assert.rejects(() => budget.beforeRequest(), /REQUEST_BUDGET_EXCEEDED/);
  assert.throws(() => budget.consume(11), /BYTE_BUDGET_EXCEEDED/);
});

test("directory parsing chooses only an actually listed non-future model run", () => {
  const dates = parseRunDates('<a href="gfs.20261021/">old</a><a href="gfs.20261022/">new</a>');
  const cycles = parseCycles('<a href="00/">00</a><a href="06/">06</a><a href="18/">18</a>');
  const result = selectLatestRun(dates, { 20261021: ["18"], 20261022: cycles }, new Date("2026-10-22T12:00:00Z"));
  assert.equal(result.modelRunAt, "2026-10-22T06:00:00.000Z");
});

test("latest run must publish the configured final forecast index before downloads begin", async () => {
  const run = { runDate: "20261022", cycle: "06" };
  const url = buildRawIndexUrl({ ...run, forecastHour: 120 });
  assert.equal(url.pathname.endsWith("gfs.t06z.pgrb2.0p25.f120.idx"), true);
  const availableBudget = new DownloadBudget({ maxRequests: 1, maxBytes: 0, minimumIntervalMs: 0 });
  let requestOptions;
  assert.equal(await verifyRunComplete(run, 120, availableBudget, async (_url, options) => {
    requestOptions = options;
    return { status: 206, body: { cancel: async () => {} } };
  }), true);
  assert.equal(requestOptions.method, "GET");
  assert.equal(requestOptions.headers.Range, "bytes=0-0");
  const missingBudget = new DownloadBudget({ maxRequests: 1, maxBytes: 0, minimumIntervalMs: 0 });
  assert.equal(await verifyRunComplete(run, 120, missingBudget, async () => ({ status: 404 })), false);
});

test("collector package is standalone and collection workflow is manual-only and credential-free", async () => {
  const workflow = await readFile(join(here, "../.github/workflows/collect-gfs.yml"), "utf8");
  const sourceFiles = ["contracts.mjs", "object-store.mjs", "publisher.mjs", "adapter.mjs", "retention.mjs", "workflow.mjs", "noaa.mjs"];
  for (const file of sourceFiles) {
    const source = await readFile(join(here, `../src/${file}`), "utf8");
    assert.doesNotMatch(source, /\.\.\/\.\.\//);
  }
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /schedule:|pull_request:/);
  assert.match(workflow, /GFS_COLLECTION_MODE: "48H"/);
  assert.match(workflow, /GFS_FORECAST_HOURS: "1,2,3,[^"]*,48"/);
  assert.match(workflow, /GFS_MAX_REQUESTS: "55"/);
  assert.match(workflow, /GFS_MAX_DOWNLOAD_BYTES: "15728640"/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /retention-days: 3/);
  assert.doesNotMatch(workflow, /R2_|secrets\./);
  assert.ok(workflow.endsWith("\n"));
});

test("48-hour collector chooses only complete runs and emits sanitized evidence", async () => {
  const source = await readFile(join(here, "../scripts/collect-and-publish.mjs"), "utf8");
  const summary = await readFile(join(here, "../scripts/write-run-summary.mjs"), "utf8");
  assert.match(source, /const candidates = listPublishedRuns/);
  assert.match(source, /GFS_NO_COMPLETE_48H_RUN_WITHIN_BUDGET/);
  assert.match(source, /weather\.gfs\.collection-evidence\.v2/);
  assert.match(source, /collection-evidence\.json/);
  assert.doesNotMatch(source, /ACCESS_KEY|SECRET_ACCESS_KEY/);
  assert.match(summary, /NOAA requests:/);
  assert.match(summary, /NOAA bytes:/);
});

test("R2 uploader is fail-closed and uploads latest last", async () => {
  const source = await readFile(join(here, "../scripts/publish-r2.mjs"), "utf8");
  assert.match(source, /R2_REMOTE_EXECUTION_FLAG_REQUIRED/);
  assert.match(source, /ordered = \[\.\.\.descriptors/);
  assert.match(source, /LATEST_KEY\]/);
  assert.match(source, /R2_REMOTE_(?:HEAD|BODY)_INTEGRITY_FAILED/);
  assert.doesNotMatch(source, /console\.log\(process\.env|SECRET_ACCESS_KEY.*stdout/);
});

test("standalone package pins the intended repository name and runtime", async () => {
  const packageJson = JSON.parse(await readFile(join(here, "../package.json"), "utf8"));
  assert.equal(packageJson.name, "guis-weather-data-collector");
  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.engines.node, ">=22");
});
