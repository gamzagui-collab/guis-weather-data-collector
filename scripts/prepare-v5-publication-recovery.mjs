import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseJson } from "../src/contracts.mjs";
import { LocalObjectStore } from "../src/object-store.mjs";
import { prepareV5PublicationRecovery } from "../src/recover-v5-publication.mjs";

const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const storeRoot = arg("--store");
const inventoryPath = arg("--inventory");
const planPath = arg("--plan");
const expectedRunId = arg("--run-id");
const expectedLatestSha256 = arg("--latest-sha256");
if (!storeRoot || !inventoryPath || !planPath) throw new Error("GFS_V5_RECOVERY_ARGUMENTS_REQUIRED");
const store = new LocalObjectStore(resolve(storeRoot));
const inventory = parseJson(await readFile(resolve(inventoryPath)), "GFS_V5_RECOVERY_INVENTORY_JSON_INVALID");
const recovery = await prepareV5PublicationRecovery(store, { expectedRunId, expectedLatestSha256, inventory });
if (recovery.status === "ALREADY_COMPLETE") {
  await writeFile(resolve(planPath), `${JSON.stringify({ status: "ALREADY_COMPLETE", runId: recovery.runId,
    expectedLatestSha256 })}\n`, "utf8");
} else {
  await store.put(recovery.publicationObject.key, recovery.publicationObject.body);
  await store.put("recovery/latest.json", recovery.latestObject.body);
  const plan = {
    schemaVersion: "weather.gfs.v5-publication-recovery.v1",
    status: "READY",
    runId: recovery.runId,
    expectedLatest: { key: "horizons/144h/latest.json", sha256: recovery.expectedLatestSha256 },
    publication: { key: recovery.publicationObject.key, bytes: recovery.publicationObject.bytes,
      sha256: recovery.publicationObject.sha256, contentType: "application/json" },
    latest: { key: "horizons/144h/latest.json", bytes: recovery.latestObject.bytes,
      sha256: recovery.latestObject.sha256, contentType: "application/json", localPath: "recovery/latest.json" }
  };
  await writeFile(resolve(planPath), `${JSON.stringify(plan)}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify({ status: recovery.status, runId: recovery.runId,
  publicationSha256: recovery.publicationObject?.sha256 || null,
  recoveredLatestSha256: recovery.latestObject.sha256 })}\n`);
