import { validateForecastShard, validateGridShard } from "./contracts.mjs";

export const CUTOVER_48H_HOURS = Object.freeze(Array.from({ length: 48 }, (_, index) => index + 1));
export const R2_SOFT_STOP_BYTES = 8 * 1024 * 1024 * 1024;

const JSON_EQUAL = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function iso(value, code) {
  if (!Number.isFinite(Date.parse(value || ""))) throw new Error(code);
  return new Date(value).toISOString();
}

function semanticManifestIdentity(value) {
  return {
    provider: value?.provider,
    model: value?.model,
    broker: value?.broker,
    source: value?.source,
    sourceUrl: value?.sourceUrl,
    product: value?.product,
    variable: value?.variable,
    modelRunAt: value?.modelRunAt,
    publishedAt: value?.publishedAt,
    sourceUnit: value?.sourceUnit,
    unit: value?.unit,
    area: value?.area
  };
}

function semanticFrame(value) {
  const frame = value?.frame;
  return {
    schemaVersion: value?.schemaVersion,
    status: value?.status,
    provider: value?.provider,
    model: value?.model,
    broker: value?.broker,
    source: value?.source,
    sourceUrl: value?.sourceUrl,
    product: value?.product,
    variable: value?.variable,
    modelRunAt: value?.modelRunAt,
    publishedAt: value?.publishedAt,
    sourceUnit: value?.sourceUnit,
    unit: value?.unit,
    area: value?.area,
    frameId: value?.frameId,
    frame: {
      messageIndex: frame?.messageIndex,
      messageSha256: frame?.messageSha256,
      sourceDataSha256: frame?.sourceDataSha256,
      sourceFile: frame?.sourceFile,
      modelRunAt: frame?.modelRunAt,
      validAt: frame?.validAt,
      forecastHour: frame?.forecastHour,
      accumulationStart: frame?.accumulationStart,
      accumulationEnd: frame?.accumulationEnd,
      accumulationPeriod: frame?.accumulationPeriod,
      stepRange: frame?.stepRange,
      sourceUnit: frame?.sourceUnit,
      unit: frame?.unit,
      conversion: frame?.conversion,
      packing: frame?.packing,
      values: frame?.values,
      statistics: frame?.statistics
    }
  };
}

function descriptorMap(manifest, label) {
  if (manifest?.status !== "COMPLETE" || !Array.isArray(manifest.forecasts)) {
    throw new Error(`GFS_CUTOVER_${label}_MANIFEST_INVALID`);
  }
  const selected = manifest.forecasts.filter((item) => CUTOVER_48H_HOURS.includes(item.forecastHour));
  const hours = [...new Set(selected.map((item) => item.forecastHour))].sort((a, b) => a - b);
  if (!JSON_EQUAL(hours, CUTOVER_48H_HOURS)) throw new Error(`GFS_CUTOVER_${label}_48H_COVERAGE_INVALID`);
  const byFrame = new Map();
  for (const item of selected) {
    if (typeof item?.frameId !== "string" || byFrame.has(item.frameId)) throw new Error(`GFS_CUTOVER_${label}_FRAME_DUPLICATE`);
    byFrame.set(item.frameId, item);
  }
  return byFrame;
}

export function compareSameRunOfficialContracts({
  manifest48,
  manifest144,
  grid48,
  grid144,
  shards48,
  shards144
}) {
  const run48 = iso(manifest48?.modelRunAt, "GFS_CUTOVER_48H_MODEL_RUN_INVALID");
  const run144 = iso(manifest144?.modelRunAt, "GFS_CUTOVER_144H_MODEL_RUN_INVALID");
  if (run48 !== run144 || manifest48?.runId !== manifest144?.runId) throw new Error("GFS_CUTOVER_MODEL_RUN_MISMATCH");
  if (!JSON_EQUAL(semanticManifestIdentity(manifest48), semanticManifestIdentity(manifest144))) {
    throw new Error("GFS_CUTOVER_PROVENANCE_MISMATCH");
  }
  validateGridShard(grid48);
  validateGridShard(grid144);
  const gridContract48 = {
    type: grid48.grid.type,
    Ni: grid48.grid.Ni,
    Nj: grid48.grid.Nj,
    resolutionDegrees: grid48.grid.resolutionDegrees,
    points: grid48.grid.points
  };
  const gridContract144 = {
    type: grid144.grid.type,
    Ni: grid144.grid.Ni,
    Nj: grid144.grid.Nj,
    resolutionDegrees: grid144.grid.resolutionDegrees,
    points: grid144.grid.points
  };
  if (!JSON_EQUAL(gridContract48, gridContract144)) throw new Error("GFS_CUTOVER_GRID_MISMATCH");

  const descriptors48 = descriptorMap(manifest48, "48H");
  const descriptors144 = descriptorMap(manifest144, "144H");
  if (!JSON_EQUAL([...descriptors48.keys()].sort(), [...descriptors144.keys()].sort())) {
    throw new Error("GFS_CUTOVER_CONTRACT_SET_MISMATCH");
  }
  let valueCount = 0;
  let availableCount = 0;
  let missingCount = 0;
  let zeroCount = 0;
  let positiveCount = 0;
  for (const frameId of [...descriptors48.keys()].sort()) {
    const left = shards48.get(frameId);
    const right = shards144.get(frameId);
    if (!left || !right) throw new Error("GFS_CUTOVER_SHARD_MISSING");
    validateForecastShard(left, grid48.grid.points.length);
    validateForecastShard(right, grid144.grid.points.length);
    if (!JSON_EQUAL(semanticFrame(left), semanticFrame(right))) throw new Error(`GFS_CUTOVER_FRAME_MISMATCH:${frameId}`);
    valueCount += left.frame.values.length;
    for (const value of left.frame.values) {
      if (value.status === "MISSING") missingCount += 1;
      else {
        availableCount += 1;
        if (value.quantitativeValue === 0) zeroCount += 1;
        else if (value.quantitativeValue > 0) positiveCount += 1;
      }
    }
  }
  return {
    status: "COMPATIBLE",
    modelRunAt: run48,
    runId: manifest48.runId,
    forecastHours: [...CUTOVER_48H_HOURS],
    contractCount: descriptors48.size,
    gridPointCount: grid48.grid.points.length,
    valueCount,
    availableCount,
    missingCount,
    zeroCount,
    positiveCount,
    fetchedAtMayDiffer: manifest48.fetchedAt !== manifest144.fetchedAt
  };
}

function normalizeRun(run) {
  if (!new Set(["48H", "144H"]).has(run?.namespace) || !/^\d{8}T\d{6}Z$/.test(run?.runId || "")
    || !Number.isSafeInteger(run?.objectCount) || run.objectCount < 1
    || !Number.isSafeInteger(run?.bytes) || run.bytes < 1) throw new Error("GFS_RETENTION_RUN_INVALID");
  return { ...run, modelRunAt: iso(run.modelRunAt, "GFS_RETENTION_MODEL_RUN_INVALID") };
}

export function buildRetentionDryRun({ runs, latest48RunId, latest144RunId, currentBytes, staging = [], softStopBytes = R2_SOFT_STOP_BYTES }) {
  if (!Number.isSafeInteger(currentBytes) || currentBytes < 0 || !Number.isSafeInteger(softStopBytes) || softStopBytes < 1) {
    throw new Error("GFS_RETENTION_STORAGE_INPUT_INVALID");
  }
  const normalized = (Array.isArray(runs) ? runs : []).map(normalizeRun);
  const latestByNamespace = new Map([["48H", latest48RunId], ["144H", latest144RunId]]);
  const retentionCount = new Map([["48H", 2], ["144H", 3]]);
  const keep = [];
  const deleteCandidates = [];
  const reviewRequired = [];
  for (const namespace of ["48H", "144H"]) {
    const scoped = normalized.filter((run) => run.namespace === namespace)
      .sort((left, right) => Date.parse(right.modelRunAt) - Date.parse(left.modelRunAt));
    const latestRunId = latestByNamespace.get(namespace);
    if (scoped.length && !scoped.some((run) => run.runId === latestRunId && run.complete === true)) {
      throw new Error(`GFS_RETENTION_${namespace}_LATEST_NOT_COMPLETE`);
    }
    let keptComplete = 0;
    for (const run of scoped) {
      if (run.complete !== true) {
        reviewRequired.push({ ...run, reason: "RUN_COMPLETENESS_UNCONFIRMED" });
        continue;
      }
      const protectedLatest = run.runId === latestRunId;
      if (protectedLatest || keptComplete < retentionCount.get(namespace)) {
        keep.push({ ...run, reason: protectedLatest ? "LATEST_POINTER_TARGET" : "RECOVERY_RUN" });
        keptComplete += 1;
      } else deleteCandidates.push({ ...run, reason: "COMPLETE_RUN_OUTSIDE_RETENTION" });
    }
  }
  for (const item of Array.isArray(staging) ? staging : []) {
    if (item?.explicitStaging !== true || !Number.isSafeInteger(item.objectCount) || item.objectCount < 1
      || !Number.isSafeInteger(item.bytes) || item.bytes < 1) {
      reviewRequired.push({ ...item, reason: "STAGING_IDENTITY_UNCONFIRMED" });
    } else deleteCandidates.push({ ...item, reason: "EXPLICIT_INCOMPLETE_STAGING" });
  }
  if (deleteCandidates.some((run) => (run.namespace === "48H" && run.runId === latest48RunId)
    || (run.namespace === "144H" && run.runId === latest144RunId))) {
    throw new Error("GFS_RETENTION_LATEST_DELETE_BLOCKED");
  }
  const candidateBytes = deleteCandidates.reduce((sum, run) => sum + run.bytes, 0);
  const averages = Object.fromEntries(["48H", "144H"].map((namespace) => {
    const values = normalized.filter((run) => run.namespace === namespace && run.complete === true).map((run) => run.bytes);
    return [namespace, values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0];
  }));
  const projectedDailyGrowthBytes = 4 * averages["48H"] + 4 * averages["144H"];
  const remaining = Math.max(0, softStopBytes - currentBytes);
  return {
    status: "DRY_RUN_ONLY",
    policy: { keep48hCompleteRuns: 2, keep144hCompleteRuns: 3, deleteByRunManifestOnly: true },
    currentBytes,
    currentObjectCount: normalized.reduce((sum, run) => sum + run.objectCount, 0),
    keep,
    deleteCandidates,
    reviewRequired,
    candidateObjectCount: deleteCandidates.reduce((sum, run) => sum + run.objectCount, 0),
    candidateBytes,
    projectedBytesAfterDryRun: currentBytes - candidateBytes,
    averageCompleteRunBytes: averages,
    projectedDailyGrowthBytes,
    projected30DayGrowthBytes: projectedDailyGrowthBytes * 30,
    softStopBytes,
    estimatedDaysToSoftStopWithoutRetention: projectedDailyGrowthBytes > 0 ? Math.floor(remaining / projectedDailyGrowthBytes) : null,
    deleteExecuted: false,
    lifecyclePolicyChanged: false
  };
}

export function evaluateIndependentHorizonStatus({ horizon, latest, schedule, publication, storageUsage, now = new Date() }) {
  if (!new Set(["48H", "144H"]).has(horizon)) throw new Error("GFS_HORIZON_STATUS_SCOPE_INVALID");
  const state = {
    horizon,
    lastScheduledAttemptAt: schedule?.lastScheduledAttemptAt || null,
    lastScheduledSuccessAt: schedule?.lastScheduledSuccessAt || null,
    lastPublishedAt: publication?.lastPublishedAt || null,
    modelRunAt: latest?.modelRunAt || null,
    latestValidAt: latest?.latestValidAt || null,
    coverage: latest?.coverage || null,
    failureCode: schedule?.failureCode || publication?.failureCode || null,
    consecutiveFailures: Number(schedule?.consecutiveFailures || 0),
    scheduleDelay: schedule?.scheduleDelay || null,
    storageUsage: Number(storageUsage || 0),
    evaluatedAt: now.toISOString()
  };
  if (!Number.isInteger(state.consecutiveFailures) || state.consecutiveFailures < 0
    || !Number.isFinite(state.storageUsage) || state.storageUsage < 0) throw new Error("GFS_HORIZON_STATUS_VALUE_INVALID");
  state.status = state.failureCode || state.consecutiveFailures > 0 ? "DELAYED"
    : latest?.status === "AVAILABLE" ? "HEALTHY" : "UNAVAILABLE";
  return state;
}
