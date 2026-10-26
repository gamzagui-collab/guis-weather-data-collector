const HOUR_MS = 60 * 60 * 1000;

export const COLLECTOR_SCHEDULE = Object.freeze({ hours: [5, 11, 17, 23], minute: 37 });
export const MONITOR_SCHEDULE = Object.freeze({ hours: [2, 8, 14, 20], minute: 17 });
export const SCHEDULE_DELAY_WARNING_MS = 90 * 60 * 1000;
export const SCHEDULE_MISSING_MS = 4 * HOUR_MS;

function instant(value, code) {
  const parsed = Date.parse(value || "");
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}

function normalizedRuns(runs) {
  return (Array.isArray(runs) ? runs : [])
    .filter((run) => run?.status === "completed" && Number.isFinite(Date.parse(run.created_at || run.createdAt || "")))
    .sort((left, right) => Date.parse(right.created_at || right.createdAt) - Date.parse(left.created_at || left.createdAt));
}

export function expectedScheduleSlot(now, schedule) {
  const nowMs = instant(now instanceof Date ? now.toISOString() : now, "SCHEDULE_MONITOR_NOW_INVALID");
  const date = new Date(nowMs);
  const candidates = [];
  for (const dayOffset of [0, -1]) {
    for (const hour of schedule.hours) {
      candidates.push(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + dayOffset,
        hour, schedule.minute, 0, 0));
    }
  }
  const selected = candidates.filter((value) => value <= nowMs).sort((left, right) => right - left)[0];
  if (!Number.isFinite(selected)) throw new Error("SCHEDULE_MONITOR_SLOT_INVALID");
  return new Date(selected).toISOString();
}

export function inferRunScheduleSlot(createdAt, schedule) {
  return expectedScheduleSlot(createdAt, schedule);
}

function runSummary(run, schedule) {
  if (!run) return null;
  const createdAt = run.created_at || run.createdAt;
  const scheduledFor = inferRunScheduleSlot(createdAt, schedule);
  return {
    id: String(run.id),
    event: run.event,
    conclusion: run.conclusion,
    createdAt,
    updatedAt: run.updated_at || run.updatedAt || null,
    scheduledFor,
    startDelayMs: Math.max(0, Date.parse(createdAt) - Date.parse(scheduledFor))
  };
}

export function evaluateScheduleMonitor({
  collectorRuns,
  monitorRuns = [],
  currentMonitorRun = null,
  now = new Date(),
  collectorSchedule = COLLECTOR_SCHEDULE,
  monitorSchedule = MONITOR_SCHEDULE,
  delayWarningMs = SCHEDULE_DELAY_WARNING_MS,
  missingMs = SCHEDULE_MISSING_MS,
  activeSince = null
}) {
  const nowIso = now instanceof Date ? now.toISOString() : new Date(instant(now, "SCHEDULE_MONITOR_NOW_INVALID")).toISOString();
  const nowMs = Date.parse(nowIso);
  const activeSinceMs = activeSince === null ? null : instant(activeSince, "SCHEDULE_MONITOR_ACTIVE_SINCE_INVALID");
  const completed = normalizedRuns(collectorRuns);
  const scheduled = completed.filter((run) => run.event === "schedule");
  const manual = completed.filter((run) => run.event === "workflow_dispatch");
  const scheduledSummaries = scheduled.map((run) => runSummary(run, collectorSchedule));
  const lastScheduled = scheduledSummaries[0] || null;
  const lastScheduledSuccess = runSummary(scheduled.find((run) => run.conclusion === "success"), collectorSchedule);
  const lastManual = manual[0] ? {
    id: String(manual[0].id), conclusion: manual[0].conclusion,
    createdAt: manual[0].created_at || manual[0].createdAt,
    updatedAt: manual[0].updated_at || manual[0].updatedAt || null
  } : null;
  const firstScheduledSuccessIndex = scheduled.findIndex((run) => run.conclusion === "success");
  const consecutiveScheduledFailures = firstScheduledSuccessIndex < 0 ? scheduled.length : firstScheduledSuccessIndex;
  const collectorDueCutoff = new Date(nowMs - missingMs).toISOString();
  const expectedCollectorSlot = expectedScheduleSlot(collectorDueCutoff, collectorSchedule);
  const expectedCollectorAgeMs = Math.max(0, nowMs - Date.parse(expectedCollectorSlot));
  const collectorSlotObserved = scheduledSummaries.some((run) => run.scheduledFor === expectedCollectorSlot);
  const collectorScheduleExpected = activeSinceMs === null || Date.parse(expectedCollectorSlot) >= activeSinceMs;
  const collectorScheduleMissing = collectorScheduleExpected && !collectorSlotObserved && expectedCollectorAgeMs > missingMs;

  const currentScheduledMonitor = currentMonitorRun?.event === "schedule"
    && Number.isFinite(Date.parse(currentMonitorRun.created_at || currentMonitorRun.createdAt || ""))
    ? { ...currentMonitorRun, status: "completed" }
    : null;
  const monitorEvidence = currentScheduledMonitor
    ? [currentScheduledMonitor, ...monitorRuns.filter((run) => String(run?.id) !== String(currentScheduledMonitor.id))]
    : monitorRuns;
  const completedMonitors = normalizedRuns(monitorEvidence).filter((run) => run.event === "schedule");
  const monitorSummaries = completedMonitors.map((run) => runSummary(run, monitorSchedule));
  const lastMonitorScheduled = monitorSummaries[0] || null;
  const monitorDueCutoff = new Date(nowMs - missingMs).toISOString();
  const expectedMonitorSlot = expectedScheduleSlot(monitorDueCutoff, monitorSchedule);
  const expectedMonitorAgeMs = Math.max(0, nowMs - Date.parse(expectedMonitorSlot));
  const monitorSlotObserved = monitorSummaries.some((run) => run.scheduledFor === expectedMonitorSlot);
  const monitorScheduleExpected = activeSinceMs === null || Date.parse(expectedMonitorSlot) >= activeSinceMs;
  const monitorScheduleMissing = monitorScheduleExpected && !monitorSlotObserved && expectedMonitorAgeMs > missingMs;

  const reasons = [];
  if (lastScheduled?.startDelayMs > delayWarningMs) reasons.push("COLLECTOR_SCHEDULE_START_DELAYED");
  if (collectorScheduleMissing) reasons.push("COLLECTOR_SCHEDULE_EXECUTION_MISSING");
  if (consecutiveScheduledFailures >= 2) reasons.push("COLLECTOR_CONSECUTIVE_SCHEDULE_FAILURES");
  if (lastMonitorScheduled?.startDelayMs > delayWarningMs) reasons.push("MONITOR_SCHEDULE_START_DELAYED");
  if (monitorScheduleMissing) reasons.push("MONITOR_SCHEDULE_EXECUTION_MISSING");

  return {
    evaluatedAt: nowIso,
    status: reasons.some((reason) => reason.endsWith("_MISSING") || reason.includes("FAILURES")) ? "FAILED"
      : reasons.length ? "DELAYED" : "HEALTHY",
    reasons,
    lastScheduled,
    lastScheduledSuccess,
    lastManual,
    consecutiveScheduledFailures,
    expectedCollectorSlot,
    collectorScheduleExpected,
    collectorSlotObserved,
    lastMonitorScheduled,
    currentMonitorRunObserved: Boolean(currentScheduledMonitor),
    expectedMonitorSlot,
    monitorScheduleExpected,
    monitorSlotObserved
  };
}
