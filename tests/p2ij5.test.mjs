import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { evaluateCanaryPolicy } from "../src/canary-policy.mjs";
import { mergeCanaryState } from "../src/canary-state.mjs";
import { classifyDiscoveredRun } from "../src/run-state.mjs";
import { evaluateScheduleMonitor } from "../src/schedule-monitor.mjs";
import { buildRetentionDryRun } from "../src/cutover-readiness.mjs";
import {
  evaluateStorageProtection,
  GFS_ESTIMATED_144H_INDEXED_RUN_BYTES,
  R2_STORAGE_STOP_BYTES
} from "../src/storage-policy.mjs";

const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), "utf8");
const config = {
  enabled: true,
  startsAt: "2026-10-25T06:45:00Z",
  expiresAt: "2026-10-27T06:45:00Z",
  publicationLimit: 2
};

test("Canary blocks before start, after expiry, and at publication cap before upstream", () => {
  assert.equal(evaluateCanaryPolicy({ ...config, now: "2026-10-25T06:44:59Z", publishedCount: 0 }).status, "CANARY_NOT_STARTED");
  assert.equal(evaluateCanaryPolicy({ ...config, now: "2026-10-25T06:45:00Z", publishedCount: 0 }).allowUpstream, true);
  assert.equal(evaluateCanaryPolicy({ ...config, now: "2026-10-26T00:00:00Z", publishedCount: 2 }).status,
    "CANARY_PUBLICATION_LIMIT_REACHED");
  assert.equal(evaluateCanaryPolicy({ ...config, now: "2026-10-27T06:45:00Z", publishedCount: 0 }).status, "CANARY_EXPIRED");
});

test("Canary rejects malformed windows and counters", () => {
  assert.throws(() => evaluateCanaryPolicy({ ...config, now: "2026-10-26T00:00:00Z", expiresAt: config.startsAt,
    publishedCount: 0 }), /WINDOW_INVALID/);
  assert.throws(() => evaluateCanaryPolicy({ ...config, now: "2026-10-26T00:00:00Z", publishedCount: -1 }),
    /PUBLISHED_COUNT_INVALID/);
});

function attempt(overrides = {}) {
  return {
    startsAt: config.startsAt,
    expiresAt: config.expiresAt,
    baselineModelRunAt: "2026-10-23T06:00:00Z",
    publicationLimit: 2,
    requestsUsed: 130,
    bytesUsed: 1_000_000,
    workflowRunId: "40100000001",
    eventName: "schedule",
    attemptedAt: "2026-10-25T07:20:00Z",
    outcome: "NEW_RUN",
    publishResult: "success",
    publishedModelRunAt: "2026-10-24T18:00:00Z",
    publishedRunId: "20261024T180000Z",
    recordedAt: "2026-10-25T08:00:00Z",
    ...overrides
  };
}

test("Canary state aggregates NOAA usage and deduplicates a rerun", () => {
  const first = mergeCanaryState(null, attempt());
  const duplicate = mergeCanaryState(first, attempt({ recordedAt: "2026-10-25T08:01:00Z" }));
  assert.equal(duplicate.totalNoaaRequests, 130);
  assert.equal(duplicate.totalNoaaBytes, 1_000_000);
  assert.equal(duplicate.attempts.length, 1);
  assert.equal(duplicate.successfulPublications.length, 1);
});

test("Canary state preserves scheduled/manual distinction and enforces two publications", () => {
  const first = mergeCanaryState(null, attempt());
  const second = mergeCanaryState(first, attempt({ workflowRunId: "40100000002", eventName: "workflow_dispatch",
    requestsUsed: 4, bytesUsed: 0, outcome: "NO_NEW_COMPLETE_RUN", publishResult: "skipped",
    publishedModelRunAt: null, publishedRunId: null, attemptedAt: "2026-10-25T09:00:00Z", recordedAt: "2026-10-25T09:01:00Z" }));
  assert.equal(second.attempts[0].eventName, "schedule");
  assert.equal(second.attempts[1].eventName, "workflow_dispatch");
  assert.equal(second.totalNoaaRequests, 134);
  const third = mergeCanaryState(second, attempt({ workflowRunId: "40100000003", publishedModelRunAt: "2026-10-25T00:00:00Z",
    publishedRunId: "20261025T000000Z", attemptedAt: "2026-10-25T19:20:00Z", recordedAt: "2026-10-25T20:00:00Z" }));
  assert.equal(third.successfulPublications.length, 2);
  assert.throws(() => mergeCanaryState(third, attempt({ workflowRunId: "40100000004",
    publishedModelRunAt: "2026-10-25T06:00:00Z", publishedRunId: "20261025T060000Z",
    attemptedAt: "2026-10-26T07:20:00Z", recordedAt: "2026-10-26T08:00:00Z" })), /LIMIT_EXCEEDED/);
});

test("144H verified Artifact recovers without NOAA recollection", () => {
  const result = classifyDiscoveredRun({
    collectionMode: "144H",
    discoveredModelRunAt: "2026-10-24T18:00:00Z",
    publishedModelRunAt: "2026-10-23T06:00:00Z",
    publishedComplete: true,
    artifact: { name: "gfs-144h-20261024T180000Z", workflowRunId: "40100000001",
      commit: "a".repeat(40), modelRunAt: "2026-10-24T18:00:00Z" }
  });
  assert.equal(result.action, "PUBLISH_EXISTING");
  assert.equal(result.runState, "ARTIFACT_EXISTS_UNPUBLISHED");
});

test("active Canary workflow has bounded schedules, pre-upstream guard, recovery and secret separation", async () => {
  const workflow = await read(".github/workflows/collect-gfs-144h-canary.yml");
  const collect = workflow.split(/^  collect:/m)[1].split(/^  publish:/m)[0];
  const publish = workflow.split(/^  publish:/m)[1].split(/^  record-canary:/m)[0];
  assert.match(workflow, /17 7,19 \* \* \*/);
  assert.match(workflow, /GFS_144H_CANARY_EXPIRES_AT: "2026-10-27T06:45:00Z"/);
  assert.match(workflow, /GFS_144H_CANARY_PUBLICATION_LIMIT: "2"/);
  assert.match(workflow, /GFS_144H_CANARY_PUBLISHED_COUNT/);
  assert.match(workflow, /ARTIFACT_EXISTS_UNPUBLISHED/);
  assert.match(workflow, /record-canary-state-r2\.mjs --execute/);
  assert.match(workflow, /group: guis-weather-gfs-noaa-collection/);
  assert.match(workflow, /queue: max/);
  assert.doesNotMatch(collect, /secrets\.R2|R2_SECRET_ACCESS_KEY/);
  assert.doesNotMatch(publish, /collect-and-publish|nomads\.ncep/);
});

test("all NOAA collectors opt into the official multi-pending FIFO queue", async () => {
  const workflows = await Promise.all([
    read(".github/workflows/collect-gfs-automatic.yml"),
    read(".github/workflows/collect-gfs-144h-manual.yml"),
    read(".github/workflows/collect-gfs-144h-canary.yml")
  ]);
  for (const workflow of workflows) {
    assert.match(workflow, /group: guis-weather-gfs-noaa-collection/);
    assert.match(workflow, /cancel-in-progress: false\s+queue: max/);
  }
});

test("144H monitor reads actual GitHub and R2 state on its own schedule", async () => {
  const monitor = await read(".github/workflows/monitor-gfs-144h.yml");
  assert.match(monitor, /17 11,23 \* \* \*/);
  assert.match(monitor, /listWorkflowRuns/);
  assert.match(monitor, /inspect-r2-publication-144h\.mjs --execute/);
  assert.match(monitor, /CANARY_TOTAL_REQUESTS/);
  assert.match(monitor, /lastScheduled/);
  assert.doesNotMatch(monitor, /Schedule is not active/);
});

test("configured 144H monitor does not let manual success hide a missed schedule", () => {
  const result = evaluateScheduleMonitor({
    now: "2026-10-26T13:00:00Z",
    collectorSchedule: { hours: [7, 19], minute: 17 },
    monitorSchedule: { hours: [11, 23], minute: 17 },
    missingMs: 5 * 60 * 60 * 1000,
    collectorRuns: [{ id: 1, event: "workflow_dispatch", status: "completed", conclusion: "success",
      created_at: "2026-10-26T12:00:00Z" }],
    monitorRuns: [{ id: 2, event: "schedule", status: "completed", conclusion: "success",
      created_at: "2026-10-26T11:20:00Z" }]
  });
  assert.equal(result.lastManual.id, "1");
  assert.equal(result.lastScheduled, null);
  assert.equal(result.status, "FAILED");
  assert.ok(result.reasons.includes("COLLECTOR_SCHEDULE_EXECUTION_MISSING"));
});

test("144H monitor does not invent a missed slot before Canary activation", () => {
  const result = evaluateScheduleMonitor({
    now: "2026-10-25T05:13:00Z",
    activeSince: "2026-10-25T06:45:00Z",
    collectorSchedule: { hours: [7, 19], minute: 17 },
    monitorSchedule: { hours: [11, 23], minute: 17 },
    missingMs: 5 * 60 * 60 * 1000,
    collectorRuns: [],
    monitorRuns: []
  });
  assert.equal(result.collectorScheduleExpected, false);
  assert.equal(result.monitorScheduleExpected, false);
  assert.equal(result.status, "HEALTHY");
  assert.deepEqual(result.reasons, []);
});

test("Canary scripts do not delete R2 objects or expose credentials", async () => {
  const [inspect, record, collector] = await Promise.all([
    read("scripts/inspect-r2-publication-144h.mjs"),
    read("scripts/record-canary-state-r2.mjs"),
    read("scripts/collect-and-publish.mjs")
  ]);
  for (const source of [inspect, record]) assert.doesNotMatch(source, /delete-object/);
  assert.match(collector, /CANARY_POLICY_BLOCKED_BEFORE_UPSTREAM/);
  assert.doesNotMatch(record, /console\.log\(process\.env|SECRET_ACCESS_KEY.*stdout/);
});

test("retention compares latest identity within its namespace", () => {
  const result = buildRetentionDryRun({
    currentBytes: 500,
    latest48RunId: "20261025T000000Z",
    latest144RunId: "20261023T060000Z",
    runs: [
      { namespace: "48H", runId: "20261025T000000Z", modelRunAt: "2026-10-25T00:00:00Z", objectCount: 1, bytes: 100, complete: true },
      { namespace: "48H", runId: "20261024T180000Z", modelRunAt: "2026-10-24T18:00:00Z", objectCount: 1, bytes: 100, complete: true },
      { namespace: "48H", runId: "20261023T060000Z", modelRunAt: "2026-10-23T06:00:00Z", objectCount: 1, bytes: 100, complete: true },
      { namespace: "144H", runId: "20261023T060000Z", modelRunAt: "2026-10-23T06:00:00Z", objectCount: 1, bytes: 200, complete: true }
    ]
  });
  assert.deepEqual(result.deleteCandidates.map((item) => `${item.namespace}:${item.runId}`), ["48H:20261023T060000Z"]);
  assert.equal(result.deleteExecuted, false);
});

test("144H storage guard reserves indexed publication expansion, not only the download ceiling", () => {
  assert.equal(GFS_ESTIMATED_144H_INDEXED_RUN_BYTES, 80 * 1024 * 1024);
  const result = evaluateStorageProtection({
    currentBytes: R2_STORAGE_STOP_BYTES - GFS_ESTIMATED_144H_INDEXED_RUN_BYTES,
    estimatedNextRunBytes: GFS_ESTIMATED_144H_INDEXED_RUN_BYTES
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.projectedBytes, R2_STORAGE_STOP_BYTES);
});
