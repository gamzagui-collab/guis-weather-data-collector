import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeObject, parseJson, sha256 } from "../src/contracts.mjs";
import { GFS_144H_FORECAST_HOURS } from "../src/horizon-144.mjs";
import { LocalObjectStore } from "../src/object-store.mjs";
import { buildRunObjects144, LATEST_144H_KEY, readLatestOperationalPublication144 } from "../src/publisher-144.mjs";
import { prepareV5PublicationRecovery, recoverV5Publication } from "../src/recover-v5-publication.mjs";

const iso = (base, hours) => new Date(Date.parse(base) + hours * 3_600_000).toISOString();

function fixture() {
  const modelRunAt = "2026-10-25T06:00:00.000Z";
  const points = Array.from({ length: 4 }, (_, id) => ({ id,
    latitude: 35.5 + Math.floor(id / 2) * 0.25, longitude: 126.75 + (id % 2) * 0.25 }));
  const frames = [];
  const add = (hour, period, suffix = "") => frames.push({
    frameId: `f${String(hour).padStart(3, "0")}-pt${period}h${suffix}`,
    messageIndex: 1, messageSha256: `${hour.toString(16).padStart(2, "0")}${"a".repeat(62)}`.slice(0, 64),
    sourceDataSha256: `${hour.toString(16).padStart(2, "0")}${"b".repeat(62)}`.slice(0, 64),
    sourceFile: `f${hour}.grib2`, modelRunAt, forecastHour: hour, validAt: iso(modelRunAt, hour),
    accumulationStart: iso(modelRunAt, hour - period), accumulationEnd: iso(modelRunAt, hour),
    accumulationPeriod: `PT${period}H`, stepRange: `${hour - period}-${hour}`,
    sourceUnit: "kg m**-2", unit: "mm", conversion: "1 kg m-2 liquid-water equivalent = 1 mm",
    packing: { packingType: "grid_simple" },
    values: points.map((point) => point.id === 0
      ? { pointId: 0, rawValue: null, quantitativeValue: null, status: "MISSING" }
      : { pointId: point.id, rawValue: point.id === 1 ? "0" : "1.25",
        quantitativeValue: point.id === 1 ? 0 : 1.25, status: "AVAILABLE" }),
    statistics: { availableCount: 3, missingCount: 1, zeroCount: 1, positiveCount: 2, minimum: 0, maximum: 1.25 }
  });
  for (const hour of GFS_144H_FORECAST_HOURS) {
    if (hour === 12) { add(12, 12); add(12, 6, "b"); } else add(hour, hour > 120 ? 3 : 1);
  }
  return buildRunObjects144({ schemaVersion: "weather.gfs.grid.v1", provider: "NOAA/NCEP", model: "GFS",
    broker: null, source: "NOAA/NCEP NOMADS", sourceUrl: "https://nomads.ncep.noaa.gov/",
    product: "GFS 0.25 degree GRIB2 surface APCP", variable: "precipitation", modelRunAt,
    publishedAt: null, fetchedAt: "2026-10-25T07:00:00.000Z", sourceUnit: "kg m**-2", unit: "mm",
    area: { name: "Republic of Korea", bounds: { left: 126.75, right: 127, bottom: 35.5, top: 35.75 } },
    coverage: { kind: "FORECAST_HOUR_SET", label: "144H", horizonHours: 144, startForecastHour: 1,
      endForecastHour: 144, firstForecastHour: 1, lastForecastHour: 144,
      expectedForecastHours: [...GFS_144H_FORECAST_HOURS], collectedForecastHours: [...GFS_144H_FORECAST_HOURS],
      complete: true, sourceCadence: [{ startForecastHour: 1, endForecastHour: 120, intervalHours: 1 },
        { startForecastHour: 123, endForecastHour: 144, intervalHours: 3 }] },
    grid: { type: "regular_ll", Ni: 2, Nj: 2, resolutionDegrees: 0.25, points }, frames,
    duplicateMessagesRemoved: [], missingForecastHours: [], status: "AVAILABLE" });
}

async function legacyStore() {
  const root = await mkdtemp(join(tmpdir(), "gfs-v5-recovery-"));
  const store = new LocalObjectStore(root);
  const plan = fixture();
  for (const item of [plan.gridObject, ...plan.forecastObjects, plan.manifestObject,
    ...plan.indexPlan.tileObjects, plan.indexPlan.manifestObject,
    ...plan.v5Plan.catalogObjects, ...plan.v5Plan.pointObjects, plan.v5Plan.manifestObject]) {
    await store.put(item.key, item.body);
  }
  const legacyLatest = structuredClone(plan.latest);
  delete legacyLatest.indexes.v5;
  delete legacyLatest.publicReadiness;
  const latestEncoded = encodeObject(legacyLatest);
  await store.put(LATEST_144H_KEY, latestEncoded.body);
  const inventory = [
    ...plan.v5Plan.catalogObjects.map((item) => ({ key: item.key, bytes: item.bytes, sha256: item.sha256,
      contentType: "application/json", customMetadata: {} })),
    ...plan.v5Plan.pointObjects.map((item) => ({ key: item.key, bytes: item.bytes, sha256: item.sha256,
      contentType: "application/octet-stream", customMetadata: item.customMetadata })),
    { ...plan.v5Plan.manifestDescriptor, contentType: "application/json", customMetadata: {} }
  ];
  return { root, store, plan, legacyLatest, latestSha256: latestEncoded.sha256, inventory };
}

test("recovery validates immutable Source and v5, adds only publication links, and is idempotent", async () => {
  const state = await legacyStore();
  try {
    const point = state.plan.v5Plan.pointObjects[1];
    const pointBefore = sha256(await state.store.get(point.key));
    const result = await recoverV5Publication(state.store, { expectedRunId: state.plan.runId,
      expectedLatestSha256: state.latestSha256, inventory: state.inventory });
    assert.equal(result.status, "RECOVERED");
    const operational = await readLatestOperationalPublication144(state.store);
    assert.equal(operational.latest.modelRunAt, state.legacyLatest.modelRunAt);
    assert.equal(operational.latest.fetchedAt, state.legacyLatest.fetchedAt);
    assert.equal(operational.latest.manifest.sha256, state.legacyLatest.manifest.sha256);
    assert.equal(operational.publication.objectCount, state.inventory.length);
    assert.equal(sha256(await state.store.get(point.key)), pointBefore);
    const repeat = await recoverV5Publication(state.store, { expectedRunId: state.plan.runId,
      expectedLatestSha256: result.latestObject.sha256, inventory: state.inventory });
    assert.equal(repeat.status, "ALREADY_COMPLETE");
  } finally { await rm(state.root, { recursive: true, force: true }); }
});

test("recovery rejects missing, SHA, run and source-link mismatches", async (context) => {
  await context.test("missing object", async () => {
    const state = await legacyStore();
    try {
      await assert.rejects(prepareV5PublicationRecovery(state.store, { expectedRunId: state.plan.runId,
        expectedLatestSha256: state.latestSha256, inventory: state.inventory.slice(1) }), /OBJECT_MISSING/);
    } finally { await rm(state.root, { recursive: true, force: true }); }
  });
  await context.test("SHA mismatch", async () => {
    const state = await legacyStore();
    try {
      const bad = structuredClone(state.inventory); bad[0].sha256 = "0".repeat(64);
      await assert.rejects(prepareV5PublicationRecovery(state.store, { expectedRunId: state.plan.runId,
        expectedLatestSha256: state.latestSha256, inventory: bad }), /OBJECT_INTEGRITY/);
    } finally { await rm(state.root, { recursive: true, force: true }); }
  });
  await context.test("run mismatch", async () => {
    const state = await legacyStore();
    try {
      await assert.rejects(prepareV5PublicationRecovery(state.store, { expectedRunId: "20261025T120000Z",
        expectedLatestSha256: state.latestSha256, inventory: state.inventory }), /FIXED_RUN_MISMATCH/);
    } finally { await rm(state.root, { recursive: true, force: true }); }
  });
  await context.test("source manifest mismatch", async () => {
    const state = await legacyStore();
    try {
      const value = parseJson(await state.store.get(state.plan.v5Plan.manifestObject.key));
      value.sourceManifest.sha256 = "f".repeat(64);
      const encoded = encodeObject(value);
      await state.store.put(state.plan.v5Plan.manifestObject.key, encoded.body);
      const inventory = structuredClone(state.inventory);
      const descriptor = inventory.find((item) => item.key === state.plan.v5Plan.manifestObject.key);
      descriptor.bytes = encoded.bytes; descriptor.sha256 = encoded.sha256;
      await assert.rejects(prepareV5PublicationRecovery(state.store, { expectedRunId: state.plan.runId,
        expectedLatestSha256: state.latestSha256, inventory }), /MANIFEST_INVALID/);
    } finally { await rm(state.root, { recursive: true, force: true }); }
  });
});

test("recovery blocks a latest race before the pointer swap", async () => {
  const state = await legacyStore();
  try {
    await assert.rejects(recoverV5Publication(state.store, { expectedRunId: state.plan.runId,
      expectedLatestSha256: state.latestSha256, inventory: state.inventory,
      beforeLatestSwap: async () => state.store.put(LATEST_144H_KEY,
        encodeObject({ ...state.legacyLatest, concurrentUpdate: true }).body) }), /LATEST_RACE/);
  } finally { await rm(state.root, { recursive: true, force: true }); }
});

test("remote recovery is fixed-run, NOAA-free, deletion-free, shared-lock and latest-last", async () => {
  const [workflow, publisher] = await Promise.all([
    readFile(new URL("../.github/workflows/recover-gfs-144h-v5-publication.yml", import.meta.url), "utf8"),
    readFile(new URL("../python/publish_v5_recovery.py", import.meta.url), "utf8")
  ]);
  assert.match(workflow, /group: guis-weather-gfs-r2-publisher/);
  assert.match(workflow, /FIXED_RUN_ID/);
  assert.match(workflow, /GFS_144H_CANARY_EXPIRES_AT: \$\{\{ steps\.inspect\.outputs\.canary_expires_at \}\}/);
  assert.match(workflow, /GFS_144H_PUBLIC_READY: \$\{\{ steps\.inspect\.outputs\.public_ready \}\}/);
  assert.doesNotMatch(workflow, /GFS_144H_PUBLIC_READY: ["']?true["']?/);
  assert.doesNotMatch(workflow, /schedule:|nomads|collect-and-publish/i);
  assert.doesNotMatch(`${workflow}\n${publisher}`, /delete_object|delete-object|Lifecycle/);
  assert.ok(publisher.indexOf("put_object(Bucket=BUCKET, Key=publication")
    < publisher.indexOf("put_object(Bucket=BUCKET, Key=latest"));
  assert.match(publisher, /LATEST_REGRESSION_BLOCKED/);
  assert.match(publisher, /LATEST_RACE/);
});
