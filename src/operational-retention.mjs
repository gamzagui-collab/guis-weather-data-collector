import { buildRetentionDryRun } from "./cutover-readiness.mjs";

function identity(value) {
  return `${value.namespace}:${value.runId}`;
}

export function buildOperationalRetentionDryRun(input = {}) {
  const base = buildRetentionDryRun(input);
  const protectedIds = new Map();
  if (input.rollback48RunId) protectedIds.set(`48H:${input.rollback48RunId}`, "APPROVED_ROLLBACK_SOURCE");
  for (const runId of input.canary144RunIds || []) protectedIds.set(`144H:${runId}`, "CANARY_EVIDENCE");

  const promoted = [];
  const deleteCandidates = [];
  for (const candidate of base.deleteCandidates) {
    const reason = protectedIds.get(identity(candidate));
    if (reason) promoted.push({ ...candidate, reason });
    else deleteCandidates.push(candidate);
  }
  const candidateBytes = deleteCandidates.reduce((sum, value) => sum + value.bytes, 0);
  const candidateObjectCount = deleteCandidates.reduce((sum, value) => sum + value.objectCount, 0);
  return {
    ...base,
    status: "OPERATIONAL_RETENTION_DRY_RUN_ONLY",
    policyVersion: "p2ij6-v1",
    keep: [...base.keep, ...promoted],
    deleteCandidates,
    candidateBytes,
    candidateObjectCount,
    projectedBytesAfterDryRun: base.currentBytes - candidateBytes,
    protectedEvidence: [...protectedIds.entries()].map(([id, reason]) => ({ id, reason })),
    deletionCommandGenerated: false,
    deleteExecuted: false,
    lifecyclePolicyChanged: false
  };
}
