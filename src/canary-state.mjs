import { GFS_144H_NAMESPACE, gfs144ScopedKey } from "./horizon-144.mjs";

export const CANARY_144H_STATUS_KEY = gfs144ScopedKey("status/canary.json");
export const CANARY_144H_SCHEMA = "weather.gfs.canary-144h.v1";

function timestamp(value, code) {
  const parsed = Date.parse(value || "");
  if (!Number.isFinite(parsed)) throw new Error(code);
  return new Date(parsed).toISOString();
}

function count(value, code) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(code);
  return parsed;
}

export function validateCanaryState(value) {
  if (!value || value.schemaVersion !== CANARY_144H_SCHEMA || value.namespace !== GFS_144H_NAMESPACE) {
    throw new Error("GFS_144H_CANARY_STATE_INVALID");
  }
  timestamp(value.startsAt, "GFS_144H_CANARY_STATE_START_INVALID");
  timestamp(value.expiresAt, "GFS_144H_CANARY_STATE_EXPIRY_INVALID");
  timestamp(value.updatedAt, "GFS_144H_CANARY_STATE_UPDATED_INVALID");
  count(value.publicationLimit, "GFS_144H_CANARY_STATE_LIMIT_INVALID");
  count(value.totalNoaaRequests, "GFS_144H_CANARY_STATE_REQUESTS_INVALID");
  count(value.totalNoaaBytes, "GFS_144H_CANARY_STATE_BYTES_INVALID");
  if (!Array.isArray(value.attempts) || !Array.isArray(value.successfulPublications)) {
    throw new Error("GFS_144H_CANARY_STATE_HISTORY_INVALID");
  }
  return value;
}

export function mergeCanaryState(existing, attempt) {
  const startsAt = timestamp(attempt.startsAt, "GFS_144H_CANARY_RECORD_START_INVALID");
  const expiresAt = timestamp(attempt.expiresAt, "GFS_144H_CANARY_RECORD_EXPIRY_INVALID");
  if (Date.parse(expiresAt) <= Date.parse(startsAt)) throw new Error("GFS_144H_CANARY_RECORD_WINDOW_INVALID");
  const publicationLimit = count(attempt.publicationLimit, "GFS_144H_CANARY_RECORD_LIMIT_INVALID");
  const requestsUsed = count(attempt.requestsUsed, "GFS_144H_CANARY_RECORD_REQUESTS_INVALID");
  const bytesUsed = count(attempt.bytesUsed, "GFS_144H_CANARY_RECORD_BYTES_INVALID");
  if (publicationLimit < 1 || requestsUsed > 135 || bytesUsed > 20 * 1024 * 1024) {
    throw new Error("GFS_144H_CANARY_RECORD_BUDGET_INVALID");
  }
  const previous = existing ? validateCanaryState(existing) : null;
  const baselineModelRunAt = timestamp(attempt.baselineModelRunAt, "GFS_144H_CANARY_RECORD_BASELINE_INVALID");
  if (previous && (timestamp(previous.startsAt, "GFS_144H_CANARY_STATE_START_INVALID") !== startsAt
    || timestamp(previous.expiresAt, "GFS_144H_CANARY_STATE_EXPIRY_INVALID") !== expiresAt
    || previous.publicationLimit !== publicationLimit
    || timestamp(previous.baselineModelRunAt, "GFS_144H_CANARY_STATE_BASELINE_INVALID") !== baselineModelRunAt)) {
    throw new Error("GFS_144H_CANARY_RECORD_CONFIGURATION_CHANGED");
  }
  const workflowRunId = String(attempt.workflowRunId || "");
  if (!/^\d+(?::\d+)?$/.test(workflowRunId)) throw new Error("GFS_144H_CANARY_RECORD_RUN_ID_INVALID");
  const attempts = [...(previous?.attempts || [])];
  if (!attempts.some((item) => item.workflowRunId === workflowRunId)) {
    attempts.push({
      workflowRunId,
      eventName: attempt.eventName === "schedule" ? "schedule" : "workflow_dispatch",
      attemptedAt: timestamp(attempt.attemptedAt, "GFS_144H_CANARY_RECORD_ATTEMPT_TIME_INVALID"),
      outcome: String(attempt.outcome || "UNKNOWN").slice(0, 80),
      requestsUsed,
      bytesUsed,
      publishResult: String(attempt.publishResult || "skipped").slice(0, 32)
    });
  }
  const publications = [...(previous?.successfulPublications || [])];
  if (attempt.publishResult === "success" && attempt.publishedModelRunAt) {
    const modelRunAt = timestamp(attempt.publishedModelRunAt, "GFS_144H_CANARY_RECORD_MODEL_TIME_INVALID");
    if (!publications.some((item) => item.modelRunAt === modelRunAt)) {
      publications.push({
        modelRunAt,
        runId: String(attempt.publishedRunId || ""),
        workflowRunId,
        publishedAt: timestamp(attempt.recordedAt, "GFS_144H_CANARY_RECORD_PUBLISHED_TIME_INVALID")
      });
    }
  }
  if (publications.length > publicationLimit) throw new Error("GFS_144H_CANARY_PUBLICATION_LIMIT_EXCEEDED");
  const recorded = attempts.find((item) => item.workflowRunId === workflowRunId);
  return {
    schemaVersion: CANARY_144H_SCHEMA,
    namespace: GFS_144H_NAMESPACE,
    startsAt,
    expiresAt,
    baselineModelRunAt,
    publicationLimit,
    totalNoaaRequests: attempts.reduce((sum, item) => sum + item.requestsUsed, 0),
    totalNoaaBytes: attempts.reduce((sum, item) => sum + item.bytesUsed, 0),
    successfulPublications: publications.sort((a, b) => Date.parse(a.modelRunAt) - Date.parse(b.modelRunAt)),
    attempts: attempts.slice(-24),
    lastAttempt: recorded,
    updatedAt: timestamp(attempt.recordedAt, "GFS_144H_CANARY_RECORD_UPDATED_INVALID")
  };
}
