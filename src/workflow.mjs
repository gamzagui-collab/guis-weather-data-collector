import { applyRetention } from "./retention.mjs";
import { latestRunMatches, publishDataset } from "./publisher.mjs";

export async function runCollectorWorkflow({
  store,
  discoverRun,
  collectDataset,
  now = new Date(),
  retention = { keepSuccessful: 2 }
}) {
  const run = await discoverRun();
  if (!run?.modelRunAt) throw new Error("GFS_DISCOVERED_RUN_INVALID");
  if (await latestRunMatches(store, run.modelRunAt)) {
    return { status: "UNCHANGED", modelRunAt: run.modelRunAt, publication: null, retention: null };
  }
  const dataset = await collectDataset(run);
  if (Date.parse(dataset.modelRunAt) !== Date.parse(run.modelRunAt)) throw new Error("GFS_COLLECTED_RUN_MISMATCH");
  const publication = await publishDataset(store, dataset, { now });
  const retentionResult = await applyRetention(store, { ...retention, now });
  return { status: "PUBLISHED", modelRunAt: run.modelRunAt, publication, retention: retentionResult };
}
