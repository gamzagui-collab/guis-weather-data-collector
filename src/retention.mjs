import { parseJson } from "./contracts.mjs";
import { LATEST_KEY } from "./publisher.mjs";
import { assertObjectStore } from "./object-store.mjs";

function runIdFromKey(key) {
  return /^runs\/([^/]+)\//.exec(key)?.[1] || null;
}

export async function applyRetention(store, {
  keepSuccessful = 2,
  incompleteGraceMs = 24 * 60 * 60 * 1000,
  now = new Date()
} = {}) {
  assertObjectStore(store);
  if (!Number.isInteger(keepSuccessful) || keepSuccessful < 2) throw new Error("GFS_RETENTION_MINIMUM_TWO_RUNS");
  const latestBody = await store.tryGet(LATEST_KEY);
  const latestRunId = latestBody ? parseJson(latestBody).runId : null;
  const keys = await store.list("runs");
  const runIds = [...new Set(keys.map(runIdFromKey).filter(Boolean))];
  const complete = [];
  for (const runId of runIds) {
    const body = await store.tryGet(`runs/${runId}/manifest.json`);
    if (!body) continue;
    try {
      const manifest = parseJson(body);
      if (manifest.status === "COMPLETE" && manifest.runId === runId) complete.push({ runId, modelRunAt: manifest.modelRunAt });
    } catch { /* invalid manifests are treated as incomplete */ }
  }
  complete.sort((a, b) => b.modelRunAt.localeCompare(a.modelRunAt));
  const keep = new Set(complete.slice(0, keepSuccessful).map((item) => item.runId));
  if (latestRunId) keep.add(latestRunId);
  const deletedRuns = [];
  for (const runId of runIds) {
    if (keep.has(runId)) continue;
    const runKeys = keys.filter((key) => runIdFromKey(key) === runId);
    const newest = await Promise.all(runKeys.map((key) => store.head(key)));
    const newestTime = newest.reduce((value, item) => Math.max(value, Date.parse(item.lastModified)), 0);
    if (!complete.some((item) => item.runId === runId) && now.valueOf() - newestTime < incompleteGraceMs) continue;
    for (const key of runKeys) await store.delete(key);
    deletedRuns.push(runId);
  }
  return { latestRunId, keptRuns: [...keep].sort(), deletedRuns: deletedRuns.sort() };
}
