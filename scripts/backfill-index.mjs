import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { LocalObjectStore } from "../src/object-store.mjs";
import { buildIndexesFromPublishedStore, validateIndexManifest, validateIndexTile } from "../src/indexes.mjs";
import { readLatestPublication } from "../src/publisher.mjs";
import { parseJson, sha256 } from "../src/contracts.mjs";

const sourceIndex = process.argv.indexOf("--source-store");
const outputIndex = process.argv.indexOf("--output-store");
if (sourceIndex < 0 || !process.argv[sourceIndex + 1] || outputIndex < 0 || !process.argv[outputIndex + 1]) {
  throw new Error("GFS_INDEX_STORE_ARGUMENTS_REQUIRED");
}
const source = new LocalObjectStore(resolve(process.argv[sourceIndex + 1]));
const outputRoot = resolve(process.argv[outputIndex + 1]);
const output = new LocalObjectStore(outputRoot);
const { latest, manifest } = await readLatestPublication(source);
const plan = await buildIndexesFromPublishedStore(source, { latest, manifest });
await rm(outputRoot, { recursive: true, force: true });
for (const tile of plan.tileObjects) {
  await output.put(tile.key, tile.body);
  const body = await output.get(tile.key);
  if (body.byteLength !== tile.bytes || sha256(body) !== tile.sha256) throw new Error("GFS_INDEX_TILE_WRITE_FAILED");
  validateIndexTile(parseJson(body), {
    runId: latest.runId,
    sourceManifest: latest.manifest,
    descriptor: tile,
    contractCount: manifest.forecasts.length
  });
}
await output.put(plan.manifestObject.key, plan.manifestObject.body, { atomic: true });
validateIndexManifest(parseJson(await output.get(plan.manifestObject.key)), {
  runId: latest.runId,
  sourceManifest: latest.manifest
});
process.stdout.write(`${JSON.stringify({
  status: "INDEX_READY",
  runId: latest.runId,
  tileCount: plan.tileObjects.length,
  tileBytes: plan.tileObjects.reduce((sum, item) => sum + item.bytes, 0),
  manifestBytes: plan.manifestObject.bytes,
  manifestSha256: plan.manifestObject.sha256
})}\n`);
