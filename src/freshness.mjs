export const GFS_EXPECTED_CYCLE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const GFS_SCHEDULE_DELAY_MS = 8 * 60 * 60 * 1000;
export const GFS_OPERATIONAL_STALE_MS = 14 * 60 * 60 * 1000;
export const GFS_MODEL_DELAY_MS = 14 * 60 * 60 * 1000;
export const GFS_MODEL_STALE_MS = 20 * 60 * 60 * 1000;

function instant(value, code) {
  const parsed = Date.parse(value || "");
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}

export function evaluateGfsFreshness({ now = new Date(), latest, lastAttemptAt, lastSuccessAt, consecutiveFailures = 0 }) {
  const nowMs = instant(now.toISOString(), "GFS_FRESHNESS_NOW_INVALID");
  const modelRunMs = instant(latest?.modelRunAt, "GFS_FRESHNESS_MODEL_RUN_INVALID");
  const latestValidMs = instant(latest?.latestValidAt, "GFS_FRESHNESS_VALID_TIME_INVALID");
  const attemptMs = instant(lastAttemptAt, "GFS_FRESHNESS_ATTEMPT_INVALID");
  const successMs = instant(lastSuccessAt, "GFS_FRESHNESS_SUCCESS_INVALID");
  if (!Number.isInteger(consecutiveFailures) || consecutiveFailures < 0) throw new Error("GFS_FRESHNESS_FAILURE_COUNT_INVALID");
  const modelAgeMs = Math.max(0, nowMs - modelRunMs);
  const attemptAgeMs = Math.max(0, nowMs - attemptMs);
  const successAgeMs = Math.max(0, nowMs - successMs);
  const reasons = [];
  if (nowMs > latestValidMs) reasons.push("VALID_PERIOD_EXPIRED");
  if (successAgeMs > GFS_OPERATIONAL_STALE_MS) reasons.push("LAST_SUCCESS_STALE");
  if (modelAgeMs > GFS_MODEL_STALE_MS) reasons.push("MODEL_RUN_STALE");
  let status = reasons.length ? "STALE" : "FRESH";
  if (status === "FRESH") {
    if (attemptAgeMs > GFS_SCHEDULE_DELAY_MS) reasons.push("SCHEDULE_ATTEMPT_DELAYED");
    if (successAgeMs > GFS_SCHEDULE_DELAY_MS) reasons.push("SUCCESS_DELAYED");
    if (modelAgeMs > GFS_MODEL_DELAY_MS) reasons.push("MODEL_RUN_DELAYED");
    if (consecutiveFailures > 0) reasons.push("RECENT_COLLECTION_FAILURE");
    if (reasons.length) status = "DELAYED";
  }
  return {
    status,
    reasons,
    modelAgeMs,
    attemptAgeMs,
    successAgeMs,
    consecutiveFailures,
    latestValidAt: latest.latestValidAt
  };
}
