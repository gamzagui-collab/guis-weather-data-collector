import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateGfsFreshness } from "../src/freshness.mjs";
import { fixture } from "./deployment.test.mjs";
import { LocalObjectStore } from "../src/object-store.mjs";
import { publishDataset } from "../src/publisher.mjs";
import { classifyDiscoveredRun } from "../src/run-state.mjs";
import { evaluateStorageProtection, R2_STORAGE_STOP_BYTES } from "../src/storage-policy.mjs";
import { evaluateScheduleMonitor } from "../src/schedule-monitor.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const read = (relative) => readFile(join(here, "..", relative), "utf8");

test("combined manual pipeline isolates R2 credentials to publish after successful collect", async () => {
  const workflow = await read(".github/workflows/collect-gfs-automatic.yml");
  const collect = workflow.split(/^  collect:/m)[1].split(/^  publish:/m)[0];
  const publish = workflow.split(/^  publish:/m)[1];
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /37 5,11,17,23 \* \* \*/);
  assert.match(workflow, /group: guis-weather-gfs-noaa-collection/);
  assert.match(collect, /collect-and-publish\.mjs --live --local/);
  assert.match(collect, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(collect, /secrets\.|R2_(?:ACCOUNT|ACCESS|SECRET|BUCKET)/);
  assert.match(publish, /needs: \[publication-state, collect\]/);
  assert.match(publish, /ARTIFACT_EXISTS_UNPUBLISHED/);
  assert.match(publish, /secrets\.R2_ACCESS_KEY_ID_V3/);
  assert.match(publish, /actions\/download-artifact@v4/);
  assert.match(publish, /run-id: \$\{\{ needs\.collect\.outputs\.artifact_run_id \}\}/);
  assert.match(publish, /verify-artifact\.mjs/);
  assert.match(publish, /publish-r2\.mjs --execute/);
  assert.doesNotMatch(publish, /collect-and-publish|src\/noaa|nomads\.ncep/);
});

test("publication state job validates R2 without passing R2 secrets to collector", async () => {
  const workflow = await read(".github/workflows/collect-gfs-automatic.yml");
  const publicationState = workflow.split(/^  publication-state:/m)[1].split(/^  collect:/m)[0];
  const collect = workflow.split(/^  collect:/m)[1].split(/^  publish:/m)[0];
  assert.match(publicationState, /inspect-r2-publication\.mjs --execute/);
  assert.match(publicationState, /secrets\.R2_SECRET_ACCESS_KEY_V3/);
  assert.doesNotMatch(collect, /secrets\.R2_SECRET_ACCESS_KEY_V3/);
  assert.match(collect, /GFS_PUBLISHED_MODEL_RUN_AT/);
  assert.equal((collect.match(/^      artifact_name:/gm) || []).length, 1);
});

test("new complete run without artifact requires collection", () => {
  assert.deepEqual(classifyDiscoveredRun({
    discoveredModelRunAt: "2026-10-22T18:00:00Z",
    publishedModelRunAt: "2026-10-22T12:00:00Z",
    publishedComplete: true
  }), { runState: "NEW_RUN", publicationState: "NOT_PUBLISHED", action: "COLLECT" });
});

test("artifact without complete R2 publication is recovered without NOAA recollection", () => {
  const result = classifyDiscoveredRun({
    discoveredModelRunAt: "2026-10-22T18:00:00Z",
    publishedModelRunAt: "2026-10-22T12:00:00Z",
    publishedComplete: true,
    artifact: {
      name: "gfs-48h-20261022T180000Z",
      workflowRunId: "39826531450",
      commit: "3ca5539642488bb1bc17a1ede3d3b619588e7536",
      modelRunAt: "2026-10-22T18:00:00Z"
    }
  });
  assert.equal(result.runState, "ARTIFACT_EXISTS_UNPUBLISHED");
  assert.equal(result.action, "PUBLISH_EXISTING");
});

test("published complete latest run is a normal no-op", () => {
  const result = classifyDiscoveredRun({
    discoveredModelRunAt: "2026-10-22T12:00:00Z",
    publishedModelRunAt: "2026-10-22T12:00:00Z",
    publishedComplete: true
  });
  assert.equal(result.runState, "NO_NEW_COMPLETE_RUN");
  assert.equal(result.publicationState, "PUBLISHED_COMPLETE");
  assert.equal(result.action, "NOOP");
});

test("invalid existing Artifact identity fails closed", () => {
  assert.throws(() => classifyDiscoveredRun({
    discoveredModelRunAt: "2026-10-22T18:00:00Z",
    artifact: { name: "wrong", workflowRunId: "1", commit: "0".repeat(40), modelRunAt: "2026-10-22T18:00:00Z" }
  }), /ARTIFACT_IDENTITY_INVALID/);
});

test("automatic and manual R2 publishers share one publication concurrency group", async () => {
  const [automatic, manual] = await Promise.all([
    read(".github/workflows/collect-gfs-automatic.yml"),
    read(".github/workflows/publish-gfs.yml")
  ]);
  assert.match(automatic.split(/^  publish:/m)[1], /group: guis-weather-gfs-r2-publisher/);
  assert.match(manual.split(/^  publish:/m)[1], /group: guis-weather-gfs-r2-publisher/);
});

test("R2 storage protection allows normal use and blocks before soft limit", () => {
  const allowed = evaluateStorageProtection({ currentBytes: 100 * 1024 * 1024 });
  assert.equal(allowed.status, "ALLOW");
  const blocked = evaluateStorageProtection({ currentBytes: R2_STORAGE_STOP_BYTES - 10 });
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.reason, "R2_STORAGE_PROTECTION_LIMIT");
});

test("verified combined pipeline and freshness monitor schedules are active", async () => {
  const [collector, monitor] = await Promise.all([
    read(".github/workflows/collect-gfs-automatic.yml"),
    read(".github/workflows/monitor-gfs-schedule.yml")
  ]);
  assert.match(collector, /37 5,11,17,23 \* \* \*/);
  assert.match(monitor, /17 2,8,14,20 \* \* \*/);
  assert.match(monitor, /COLLECTOR_SCHEDULE_START_DELAYED/);
  assert.match(monitor, /result\.status === "FAILED"/);
  assert.match(monitor, /consecutiveScheduledFailures/);
  assert.match(monitor, /lastScheduled/);
  assert.match(monitor, /lastManual/);
  assert.match(monitor, /NO_NEW_COMPLETE_RUN/);
  assert.match(monitor, /function namedJob/);
  assert.match(monitor, /slice\(0, 20\)/);
  assert.match(monitor, /Publication scan/);
  assert.match(monitor, /lastPublication\?\.updated_at/);
  assert.match(monitor, /currentMonitorRun/);
  assert.doesNotMatch(monitor, /const completed = data\.workflow_runs/);
});

test("a running scheduled monitor observes itself instead of failing as missing", () => {
  const currentMonitorRun = {
    id: 39918907743,
    event: "schedule",
    status: "in_progress",
    conclusion: null,
    created_at: "2026-10-23T07:36:37Z"
  };
  const result = evaluateScheduleMonitor({
    now: new Date("2026-10-23T07:36:42Z"),
    collectorRuns: [{
      id: 39886451212, event: "schedule", status: "completed", conclusion: "success",
      created_at: "2026-10-23T01:52:34Z", updated_at: "2026-10-23T01:54:05Z"
    }],
    monitorRuns: [currentMonitorRun],
    currentMonitorRun
  });
  assert.equal(result.currentMonitorRunObserved, true);
  assert.equal(result.monitorSlotObserved, true);
  assert.equal(result.lastMonitorScheduled.id, "39918907743");
  assert.equal(result.status, "DELAYED");
  assert.deepEqual(result.reasons.sort(), ["COLLECTOR_SCHEDULE_START_DELAYED", "MONITOR_SCHEDULE_START_DELAYED"]);
  assert.ok(!result.reasons.includes("MONITOR_SCHEDULE_EXECUTION_MISSING"));
});

test("a running manual monitor cannot satisfy the current collector or monitor slots", () => {
  const currentMonitorRun = {
    id: 39907442061,
    event: "workflow_dispatch",
    status: "in_progress",
    conclusion: null,
    created_at: "2026-10-23T07:36:37Z"
  };
  const result = evaluateScheduleMonitor({
    now: new Date("2026-10-23T07:36:42Z"),
    collectorRuns: [{
      id: 1, event: "workflow_dispatch", status: "completed", conclusion: "success",
      created_at: "2026-10-23T07:30:00Z", updated_at: "2026-10-23T07:31:00Z"
    }],
    monitorRuns: [currentMonitorRun],
    currentMonitorRun
  });
  assert.equal(result.currentMonitorRunObserved, false);
  assert.equal(result.status, "FAILED");
  assert.equal(result.collectorSlotObserved, false);
  assert.equal(result.monitorSlotObserved, false);
  assert.equal(result.reasons.includes("MONITOR_SCHEDULE_EXECUTION_MISSING"), true);
});

test("manual success cannot hide a missing scheduled collector execution", () => {
  const result = evaluateScheduleMonitor({
    now: new Date("2026-10-23T04:00:00Z"),
    collectorRuns: [{
      id: 1, event: "workflow_dispatch", status: "completed", conclusion: "success",
      created_at: "2026-10-23T03:50:00Z", updated_at: "2026-10-23T03:55:00Z"
    }]
  });
  assert.equal(result.lastScheduled, null);
  assert.equal(result.lastManual.id, "1");
  assert.equal(result.status, "FAILED");
  assert.ok(result.reasons.includes("COLLECTOR_SCHEDULE_EXECUTION_MISSING"));
});

test("first scheduled run preserves its 135 minute delay regression evidence", () => {
  const result = evaluateScheduleMonitor({
    now: new Date("2026-10-23T02:20:00Z"),
    collectorRuns: [{
      id: 39886451212, event: "schedule", status: "completed", conclusion: "success",
      created_at: "2026-10-23T01:52:34Z", updated_at: "2026-10-23T01:54:05Z"
    }],
    monitorRuns: [{
      id: 2, event: "schedule", status: "completed", conclusion: "success",
      created_at: "2026-10-23T02:18:00Z", updated_at: "2026-10-23T02:19:00Z"
    }]
  });
  assert.equal(result.lastScheduled.scheduledFor, "2026-10-22T23:37:00.000Z");
  assert.equal(result.lastScheduled.startDelayMs, 8_134_000);
  assert.equal(result.lastScheduledSuccess.id, "39886451212");
  assert.ok(result.reasons.includes("COLLECTOR_SCHEDULE_START_DELAYED"));
  assert.equal(result.status, "DELAYED");
});

test("scheduled failures are counted independently from later manual success", () => {
  const result = evaluateScheduleMonitor({
    now: new Date("2026-10-23T15:00:00Z"),
    collectorRuns: [
      { id: 3, event: "workflow_dispatch", status: "completed", conclusion: "success", created_at: "2026-10-23T14:55:00Z" },
      { id: 2, event: "schedule", status: "completed", conclusion: "failure", created_at: "2026-10-23T14:40:00Z" },
      { id: 1, event: "schedule", status: "completed", conclusion: "failure", created_at: "2026-10-23T08:40:00Z" }
    ]
  });
  assert.equal(result.consecutiveScheduledFailures, 2);
  assert.ok(result.reasons.includes("COLLECTOR_CONSECUTIVE_SCHEDULE_FAILURES"));
  assert.equal(result.status, "FAILED");
});

test("monitor schedule absence is tracked separately from collector success", () => {
  const result = evaluateScheduleMonitor({
    now: new Date("2026-10-23T06:30:00Z"),
    collectorRuns: [{ id: 1, event: "schedule", status: "completed", conclusion: "success", created_at: "2026-10-23T05:40:00Z" }],
    monitorRuns: []
  });
  assert.equal(result.collectorSlotObserved, true);
  assert.equal(result.monitorSlotObserved, false);
  assert.ok(result.reasons.includes("MONITOR_SCHEDULE_EXECUTION_MISSING"));
});

test("manual publish can recover a verified artifact from a failed combined publish run", async () => {
  const workflow = await read(".github/workflows/publish-gfs.yml");
  assert.match(workflow, /collect-gfs-automatic\.yml/);
  assert.match(workflow, /listJobsForWorkflowRun/);
  assert.match(workflow, /job\.name === "collect" && job\.conclusion === "success"/);
  assert.doesNotMatch(workflow, /run\.conclusion !== "success"/);
  assert.match(workflow, /group: guis-weather-gfs-collector-48h/);
});

test("collector preserves sanitized success and failure evidence before exiting", async () => {
  const [collector, operation, summary] = await Promise.all([
    read("scripts/collect-and-publish.mjs"),
    read("scripts/write-operation-status.mjs"),
    read("scripts/write-run-summary.mjs")
  ]);
  assert.match(collector, /weather\.gfs\.collection-evidence\.v2/);
  assert.match(collector, /status: "FAILED"/);
  assert.match(collector, /VERIFIED_ARTIFACT_REQUIRES_PUBLICATION_CHECK/);
  assert.match(collector, /LATEST_COMPLETE_RUN_ALREADY_PUBLISHED/);
  assert.match(collector, /failureCode: error \? failureCode\(error\) : null/);
  assert.doesNotMatch(operation, /ACCESS_KEY|SECRET_ACCESS_KEY|GITHUB_TOKEN/);
  assert.match(summary, /attempt started:/);
  assert.match(summary, /pipeline status:/);
});

test("freshness is FRESH within one collection interval", () => {
  const result = evaluateGfsFreshness({
    now: new Date("2026-10-23T06:00:00Z"),
    latest: { modelRunAt: "2026-10-23T00:00:00Z", latestValidAt: "2026-10-25T00:00:00Z" },
    lastAttemptAt: "2026-10-23T05:40:00Z",
    lastSuccessAt: "2026-10-23T05:50:00Z",
    consecutiveFailures: 0
  });
  assert.equal(result.status, "FRESH");
  assert.deepEqual(result.reasons, []);
});

test("schedule delay and collection failure are explicit without changing forecast values", () => {
  const result = evaluateGfsFreshness({
    now: new Date("2026-10-23T14:00:00Z"),
    latest: { modelRunAt: "2026-10-23T00:00:00Z", latestValidAt: "2026-10-25T00:00:00Z" },
    lastAttemptAt: "2026-10-23T05:30:00Z",
    lastSuccessAt: "2026-10-23T05:30:00Z",
    consecutiveFailures: 1
  });
  assert.equal(result.status, "DELAYED");
  assert.ok(result.reasons.includes("SCHEDULE_ATTEMPT_DELAYED"));
  assert.ok(result.reasons.includes("RECENT_COLLECTION_FAILURE"));
});

test("two missed cycles or expired valid time become STALE", () => {
  const missed = evaluateGfsFreshness({
    now: new Date("2026-10-23T21:00:01Z"),
    latest: { modelRunAt: "2026-10-23T00:00:00Z", latestValidAt: "2026-10-25T00:00:00Z" },
    lastAttemptAt: "2026-10-23T05:30:00Z",
    lastSuccessAt: "2026-10-23T05:30:00Z",
    consecutiveFailures: 2
  });
  assert.equal(missed.status, "STALE");
  assert.ok(missed.reasons.includes("LAST_SUCCESS_STALE"));
  assert.ok(missed.reasons.includes("MODEL_RUN_STALE"));
  const expired = evaluateGfsFreshness({
    now: new Date("2026-10-25T00:00:01Z"),
    latest: { modelRunAt: "2026-10-23T18:00:00Z", latestValidAt: "2026-10-25T00:00:00Z" },
    lastAttemptAt: "2026-10-24T23:00:00Z",
    lastSuccessAt: "2026-10-24T23:00:00Z",
    consecutiveFailures: 0
  });
  assert.equal(expired.status, "STALE");
  assert.ok(expired.reasons.includes("VALID_PERIOD_EXPIRED"));
});

test("published status preserves run, fetched, valid and coverage timestamps", async () => {
  const root = await mkdtemp(join(tmpdir(), "gfs-p2ih2-status-"));
  try {
    const store = new LocalObjectStore(root);
    const dataset = fixture();
    dataset.coverage = {
      kind: "FORECAST_HOUR_SET", label: "CUSTOM", startForecastHour: 1, endForecastHour: 12,
      expectedForecastHours: [1, 3, 6, 12], collectedForecastHours: [1, 3, 6, 12], complete: true
    };
    await publishDataset(store, dataset, { now: new Date("2026-10-22T12:30:00Z") });
    const status = JSON.parse(await store.get("status/collector.json"));
    assert.equal(status.modelRunAt, dataset.modelRunAt);
    assert.equal(status.fetchedAt, dataset.fetchedAt);
    assert.equal(status.latestValidAt, "2026-10-22T18:00:00Z");
    assert.equal(status.coverage.label, "CUSTOM");
    assert.equal(status.publicationState, "READY_TO_PUBLISH");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publisher exposes manifest and latest SHA without logging credentials", async () => {
  const source = await read("scripts/publish-r2.mjs");
  assert.match(source, /latestSha256: sha256\(latestBody\)/);
  assert.match(source, /manifest_sha256=/);
  assert.match(source, /latest_sha256=/);
  assert.doesNotMatch(source, /console\.log\(process\.env|SECRET_ACCESS_KEY.*stdout/);
});

test("collector package version marks P2-I-J-7 preparation while the Canary remains active", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  assert.equal(packageJson.version, "0.9.1-p2ij7a");
});
