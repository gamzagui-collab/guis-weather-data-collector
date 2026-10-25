import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  evaluateOperationalCutover,
  buildCutoverProcedure,
  buildRollbackProcedure
} from "../src/operational-cutover.mjs";
import { buildOperationalRetentionDryRun } from "../src/operational-retention.mjs";

function evidence(overrides = {}) {
  return {
    canary: { scheduledRunCount: 1, scheduledPublicationCount: 1 },
    compatibility: { status: "COMPATIBLE", sameModelRun: true, modelRunAt: "2026-10-25T00:00:00Z" },
    horizon48: { scheduleActive: true, publicAccess: true },
    horizon144: { status: "AVAILABLE", freshness: "FRESH", publicAccess: false,
      modelRunAt: "2026-10-25T00:00:00Z", coverage: { complete: true, horizonHours: 144,
        collectedForecastHours: Array.from({ length: 128 }, (_, index) => index + 1) } },
    storage: { status: "ALLOW", projectedBytes: 500 },
    ...overrides
  };
}

test("operational cutover stays approval-gated while all technical evidence is ready", () => {
  const result = evaluateOperationalCutover(evidence());
  assert.equal(result.ready, true);
  assert.equal(result.phase, "CUTOVER_READY");
  const procedure = buildCutoverProcedure(result);
  assert.equal(procedure.status, "AWAITING_EXPLICIT_APPROVAL");
  assert.equal(procedure.steps.at(-1), "DISABLE_48H_SCHEDULE_ONLY_AFTER_APPROVAL");
});

test("missing scheduled Canary publication and stale 144H block cutover without stopping 48H", () => {
  const result = evaluateOperationalCutover(evidence({
    canary: { scheduledRunCount: 0, scheduledPublicationCount: 0 },
    horizon144: { ...evidence().horizon144, status: "STALE", freshness: "STALE" }
  }));
  assert.equal(result.ready, false);
  assert.ok(result.blockers.includes("GFS_144H_SCHEDULED_CANARY_PUBLICATION_REQUIRED"));
  assert.ok(result.blockers.includes("GFS_144H_COMPLETE_FRESH_RUN_REQUIRED"));
  assert.equal(result.invariants.keep48hScheduleActive, true);
});

test("rollback preserves an identified 48H source and forbids relabelling stale data", () => {
  const plan = buildRollbackProcedure({ rollback48RunId: "20261024T180000Z",
    failed144RunId: "20261025T000000Z", reason: "INDEX_INTEGRITY_FAILED" });
  assert.equal(plan.status, "PREPARED_NOT_EXECUTED");
  assert.ok(plan.forbids.includes("RELABEL_OLD_48H_AS_NEW"));
  assert.ok(plan.steps.includes("VERIFY_48H_MODEL_RUN_AND_STALE_STATE"));
});

test("retention dry run protects rollback and Canary evidence and never deletes", () => {
  const runs = [
    ["48H", "20261025T000000Z", 100], ["48H", "20261024T180000Z", 100], ["48H", "20261024T120000Z", 100],
    ["144H", "20261025T000000Z", 200], ["144H", "20261024T180000Z", 200],
    ["144H", "20261024T120000Z", 200], ["144H", "20261023T060000Z", 200]
  ].map(([namespace, runId, bytes]) => ({ namespace, runId, bytes, objectCount: 1, complete: true,
    modelRunAt: `${runId.slice(0, 4)}-${runId.slice(4, 6)}-${runId.slice(6, 8)}T${runId.slice(9, 11)}:${runId.slice(11, 13)}:${runId.slice(13, 15)}Z` }));
  const result = buildOperationalRetentionDryRun({ runs, currentBytes: 1_100,
    latest48RunId: "20261025T000000Z", latest144RunId: "20261025T000000Z",
    rollback48RunId: "20261024T120000Z", canary144RunIds: ["20261023T060000Z"] });
  assert.equal(result.deleteCandidates.length, 0);
  assert.equal(result.deleteExecuted, false);
  assert.equal(result.lifecyclePolicyChanged, false);
  assert.equal(result.keep.some((run) => run.reason === "APPROVED_ROLLBACK_SOURCE"), true);
  assert.equal(result.keep.some((run) => run.reason === "CANARY_EVIDENCE"), true);
});

test("P2-I-J-6 preparation does not mutate active Canary or 48H schedule", async () => {
  const [canary, active48, doc] = await Promise.all([
    readFile(new URL("../.github/workflows/collect-gfs-144h-canary.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/collect-gfs-automatic.yml", import.meta.url), "utf8"),
    readFile(new URL("../docs/P2-I-J-6-OPERATIONAL-CUTOVER.md", import.meta.url), "utf8")
  ]);
  assert.match(canary, /GFS_144H_CANARY_PUBLICATION_LIMIT: "2"/);
  assert.match(canary, /GFS_144H_CANARY_EXPIRES_AT: "2026-10-27T06:45:00Z"/);
  assert.match(active48, /37 5,11,17,23 \* \* \*/);
  assert.match(doc, /performs no `DeleteObject`/);
});
