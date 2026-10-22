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

const here = fileURLToPath(new URL(".", import.meta.url));
const read = (relative) => readFile(join(here, "..", relative), "utf8");

test("combined manual pipeline isolates R2 credentials to publish after successful collect", async () => {
  const workflow = await read(".github/workflows/collect-gfs-automatic.yml");
  const [beforePublish, publish] = workflow.split(/^  publish:/m);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /schedule:/);
  assert.match(workflow, /group: guis-weather-gfs-collector-48h/);
  assert.match(beforePublish, /collect-and-publish\.mjs --live --local/);
  assert.match(beforePublish, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(beforePublish, /secrets\.|R2_(?:ACCOUNT|ACCESS|SECRET|BUCKET)/);
  assert.match(publish, /needs: collect/);
  assert.match(publish, /if: needs\.collect\.result == 'success' && needs\.collect\.outputs\.collection_outcome == 'PUBLISHED'/);
  assert.match(publish, /secrets\.R2_ACCESS_KEY_ID_V3/);
  assert.match(publish, /actions\/download-artifact@v4/);
  assert.match(publish, /verify-artifact\.mjs/);
  assert.match(publish, /publish-r2\.mjs --execute/);
  assert.doesNotMatch(publish, /collect-and-publish|src\/noaa|nomads\.ncep/);
});

test("scheduled activation and monitor templates remain disabled before manual E2E", async () => {
  const [collector, monitor] = await Promise.all([
    read(".github/workflows/collect-gfs.schedule.yml.disabled"),
    read(".github/workflows/monitor-gfs-schedule.yml.disabled")
  ]);
  assert.match(collector, /37 5,11,17,23 \* \* \*/);
  assert.match(monitor, /17 2,8,14,20 \* \* \*/);
  assert.match(monitor, /GFS_SCHEDULE_ATTEMPT_MISSING/);
  assert.match(monitor, /GFS_LAST_SUCCESS_STALE/);
  assert.match(monitor, /GFS_CONSECUTIVE_FAILURES/);
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
  assert.match(collector, /collection_outcome=UNCHANGED/);
  assert.match(collector, /VERIFIED_ARTIFACT_ALREADY_EXISTS/);
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

test("collector package version marks the P2-I-H-2 deployment contract", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  assert.equal(packageJson.version, "0.4.0-p2ih2");
});
