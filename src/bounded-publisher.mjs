function assertLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16) {
    throw new Error("GFS_PUBLISH_CONCURRENCY_INVALID");
  }
  return limit;
}

export async function runBounded(items, limit, worker) {
  if (!Array.isArray(items) || typeof worker !== "function") throw new Error("GFS_PUBLISH_TASKS_INVALID");
  const bounded = Math.min(assertLimit(limit), Math.max(items.length, 1));
  const results = new Array(items.length);
  let nextIndex = 0;
  let firstFailure = null;
  const runners = Array.from({ length: bounded }, async () => {
    while (!firstFailure) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        firstFailure ||= error;
      }
    }
  });
  await Promise.all(runners);
  if (firstFailure) throw firstFailure;
  return results;
}

export async function runPublishStages(stages, {
  concurrency = 8,
  publishObject,
  beforeStage = async () => {},
  onProgress = () => {},
  progressEvery = 50,
  now = () => Date.now()
} = {}) {
  assertLimit(concurrency);
  if (!Array.isArray(stages) || !stages.length || typeof publishObject !== "function"
    || !Number.isSafeInteger(progressEvery) || progressEvery < 1) {
    throw new Error("GFS_PUBLISH_STAGES_INVALID");
  }
  const keys = stages.flatMap((stage) => stage.items || []);
  if (stages.at(-1)?.name !== "latest" || stages.at(-1)?.items?.length !== 1
    || keys.some((key) => typeof key !== "string") || new Set(keys).size !== keys.length) {
    throw new Error("GFS_PUBLISH_STAGE_ORDER_INVALID");
  }
  const startedAt = now();
  const state = { completed: 0, total: keys.length, uploaded: 0, reused: 0, nextProgress: progressEvery };
  const emit = (status, extra = {}) => onProgress({
    status,
    completed: state.completed,
    total: state.total,
    uploaded: state.uploaded,
    reused: state.reused,
    elapsedMs: Math.max(0, now() - startedAt),
    ...extra
  });

  for (const stage of stages) {
    if (!stage?.name || !Array.isArray(stage.items) || !stage.items.length) {
      throw new Error("GFS_PUBLISH_STAGE_INVALID");
    }
    try {
      await beforeStage(stage, { ...state });
      emit("R2_144H_PUBLISH_STAGE_STARTED", { stage: stage.name });
      await runBounded(stage.items, stage.serial ? 1 : concurrency, async (key, stageIndex) => {
        const outcome = await publishObject(key, { stage: stage.name, stageIndex });
        if (outcome === "uploaded") state.uploaded += 1;
        else if (outcome === "reused") state.reused += 1;
        else throw new Error("GFS_PUBLISH_OUTCOME_INVALID");
        state.completed += 1;
        if (state.completed >= state.nextProgress || state.completed === state.total) {
          while (state.nextProgress <= state.completed) state.nextProgress += progressEvery;
          emit("R2_144H_PUBLISH_PROGRESS", { stage: stage.name });
        }
      });
    } catch (error) {
      emit("R2_144H_PUBLISH_FAILED", {
        stage: stage.name,
        operation: String(error?.publishOperation || "unknown"),
        failureCode: String(error?.message || "R2_144H_PUBLISH_FAILED").slice(0, 120)
      });
      throw error;
    }
    emit("R2_144H_PUBLISH_STAGE_COMPLETED", { stage: stage.name });
  }
  return { completed: state.completed, total: state.total, uploaded: state.uploaded,
    reused: state.reused, elapsedMs: Math.max(0, now() - startedAt) };
}
