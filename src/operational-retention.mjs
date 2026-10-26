import { buildRetentionDryRun } from "./cutover-readiness.mjs";

function identity(value) {
  return `${value.namespace}:${value.runId}`;
}

export function buildOperationalRetentionDryRun(input = {}) {
  const base = buildRetentionDryRun(input);
  const protectedIds = new Map();
  if (input.rollback48RunId) protectedIds.set(`48H:${input.rollback48RunId}`, "APPROVED_ROLLBACK_SOURCE");
  for (const runId of input.canary144RunIds || []) protectedIds.set(`144H:${runId}`, "CANARY_EVIDENCE");
  for (const runId of input.activeV5RunIds || []) protectedIds.set(`144H:${runId}`, "ACTIVE_V5_SOURCE_CHAIN");

  const promoted = [];
  const deleteCandidates = [];
  for (const candidate of base.deleteCandidates) {
    const reason = protectedIds.get(identity(candidate));
    if (reason) promoted.push({ ...candidate, reason });
    else deleteCandidates.push(candidate);
  }
  const candidateBytes = deleteCandidates.reduce((sum, value) => sum + value.bytes, 0);
  const candidateObjectCount = deleteCandidates.reduce((sum, value) => sum + value.objectCount, 0);
  const scheduledRunsPerDay = {
    "48H": Number(input.scheduledRunsPerDay?.["48H"] ?? 4),
    "144H": Number(input.scheduledRunsPerDay?.["144H"] ?? 2)
  };
  if (!Number.isInteger(scheduledRunsPerDay["48H"]) || scheduledRunsPerDay["48H"] < 0
    || !Number.isInteger(scheduledRunsPerDay["144H"]) || scheduledRunsPerDay["144H"] < 0) {
    throw new Error("GFS_RETENTION_SCHEDULE_RATE_INVALID");
  }
  const projectedDailyGrowthBytes = scheduledRunsPerDay["48H"] * base.averageCompleteRunBytes["48H"]
    + scheduledRunsPerDay["144H"] * base.averageCompleteRunBytes["144H"];
  const remaining = Math.max(0, base.softStopBytes - base.currentBytes);
  const indexVersionBytes = { source: 0, v2: 0, v3: 0, v4: 0, v5: 0, other: 0 };
  for (const run of input.runs || []) {
    for (const key of Object.keys(indexVersionBytes)) {
      const bytes = Number(run?.storageBreakdown?.[key] || 0);
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("GFS_RETENTION_STORAGE_BREAKDOWN_INVALID");
      indexVersionBytes[key] += bytes;
    }
  }
  return {
    ...base,
    status: "OPERATIONAL_RETENTION_DRY_RUN_ONLY",
    policyVersion: "p2ij8-v2",
    policy: { ...base.policy, scheduledRunsPerDay, deleteGranularity: "RUN_MANIFEST_ONLY",
      experimentalIndexesRequireSeparateApproval: true },
    keep: [...base.keep, ...promoted],
    deleteCandidates,
    candidateBytes,
    candidateObjectCount,
    projectedBytesAfterDryRun: base.currentBytes - candidateBytes,
    projectedDailyGrowthBytes,
    projected30DayGrowthBytes: projectedDailyGrowthBytes * 30,
    estimatedDaysToSoftStopWithoutRetention: projectedDailyGrowthBytes > 0
      ? Math.floor(remaining / projectedDailyGrowthBytes) : null,
    storageComposition: {
      indexVersionBytes,
      experimentalBytes: indexVersionBytes.v3 + indexVersionBytes.v4,
      activeCompactIndexBytes: indexVersionBytes.v5
    },
    protectedEvidence: [...protectedIds.entries()].map(([id, reason]) => ({ id, reason })),
    deletionCommandGenerated: false,
    deleteExecuted: false,
    lifecyclePolicyChanged: false
  };
}
