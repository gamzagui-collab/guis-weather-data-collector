const CUTOVER_PHASES = Object.freeze({
  PREPARED: "PREPARED",
  CANARY_ACTIVE: "CANARY_ACTIVE",
  CANARY_VERIFIED: "CANARY_VERIFIED",
  CUTOVER_READY: "CUTOVER_READY",
  OPERATIONAL_144H: "OPERATIONAL_144H",
  ROLLBACK_REQUIRED: "ROLLBACK_REQUIRED"
});

function complete144h(value) {
  return value?.status === "AVAILABLE" && value?.freshness === "FRESH"
    && value?.coverage?.complete === true && value?.coverage?.horizonHours === 144
    && value?.coverage?.collectedForecastHours?.length === 128;
}

export function evaluateOperationalCutover({
  canary,
  compatibility,
  horizon48,
  horizon144,
  storage,
  operational144hScheduleActive = false
} = {}) {
  const blockers = [];
  if (horizon48?.scheduleActive !== true) blockers.push("GFS_48H_SCHEDULE_MUST_REMAIN_ACTIVE");
  if (horizon48?.publicAccess !== true) blockers.push("GFS_48H_PUBLIC_RECOVERY_UNAVAILABLE");
  if (horizon144?.publicAccess === true) blockers.push("GFS_144H_PUBLIC_ACTIVATION_NOT_APPROVED");
  if (!complete144h(horizon144)) blockers.push("GFS_144H_COMPLETE_FRESH_RUN_REQUIRED");
  if (compatibility?.status !== "COMPATIBLE" || compatibility?.sameModelRun !== true) {
    blockers.push("GFS_48H_144H_OFFICIAL_CONTRACT_COMPATIBILITY_REQUIRED");
  }
  if (Number(canary?.scheduledPublicationCount || 0) < 1) blockers.push("GFS_144H_SCHEDULED_CANARY_PUBLICATION_REQUIRED");
  if (storage?.status !== "ALLOW") blockers.push("GFS_R2_STORAGE_POLICY_BLOCKED");
  if (operational144hScheduleActive === true) blockers.push("GFS_144H_OPERATIONAL_SCHEDULE_ALREADY_ACTIVE");

  const canaryObserved = Number(canary?.scheduledRunCount || 0) > 0;
  const canaryVerified = Number(canary?.scheduledPublicationCount || 0) > 0;
  const phase = blockers.length === 0 ? CUTOVER_PHASES.CUTOVER_READY
    : horizon144?.failureCode || compatibility?.status === "INCOMPATIBLE" ? CUTOVER_PHASES.ROLLBACK_REQUIRED
      : canaryVerified ? CUTOVER_PHASES.CANARY_VERIFIED
        : canaryObserved ? CUTOVER_PHASES.CANARY_ACTIVE : CUTOVER_PHASES.PREPARED;
  return {
    phase,
    ready: blockers.length === 0,
    blockers,
    evidence: {
      canaryScheduledRuns: Number(canary?.scheduledRunCount || 0),
      canaryScheduledPublications: Number(canary?.scheduledPublicationCount || 0),
      compatibilityModelRunAt: compatibility?.modelRunAt || null,
      latest144hModelRunAt: horizon144?.modelRunAt || null,
      storageProjectedBytes: storage?.projectedBytes ?? null
    },
    invariants: {
      keep48hScheduleActive: true,
      keep144hPublicAccessDisabled: true,
      noNoaaManualCollection: true,
      noR2Deletion: true
    }
  };
}

export function buildCutoverProcedure(readiness) {
  if (readiness?.ready !== true) return { status: "HELD", blockers: [...(readiness?.blockers || [])], steps: [] };
  return {
    status: "AWAITING_EXPLICIT_APPROVAL",
    steps: [
      "ENABLE_144H_OPERATIONAL_SCHEDULE",
      "VERIFY_NEW_SCHEDULED_144H_COMPLETE_PUBLICATION",
      "ENABLE_144H_SHADOW_READ",
      "VERIFY_SAME_RUN_48H_COMPATIBILITY_API",
      "SWITCH_48H_API_SOURCE_TO_144H_F001_F048",
      "VERIFY_PREVIEW_AND_FRESHNESS_GUARDS",
      "DISABLE_48H_SCHEDULE_ONLY_AFTER_APPROVAL"
    ]
  };
}

export function buildRollbackProcedure({ rollback48RunId, failed144RunId, reason } = {}) {
  if (!/^\d{8}T\d{6}Z$/.test(rollback48RunId || "")) throw new Error("GFS_ROLLBACK_48H_RUN_INVALID");
  return {
    status: "PREPARED_NOT_EXECUTED",
    reason: String(reason || "GFS_144H_OPERATIONAL_FAILURE"),
    rollback48RunId,
    failed144RunId: /^\d{8}T\d{6}Z$/.test(failed144RunId || "") ? failed144RunId : null,
    steps: [
      "SET_48H_API_SOURCE_OPERATIONAL_48H_ONLY",
      "KEEP_OR_REENABLE_48H_SCHEDULE",
      "DISABLE_144H_PUBLIC_ACCESS",
      "PRESERVE_FAILED_144H_EVIDENCE",
      "VERIFY_48H_MODEL_RUN_AND_STALE_STATE",
      "VERIFY_KMA_AND_VIDEO_PROVIDERS"
    ],
    forbids: ["RELABEL_OLD_48H_AS_NEW", "DELETE_R2_RUN", "HIDE_STALE_STATE"]
  };
}

export { CUTOVER_PHASES };
