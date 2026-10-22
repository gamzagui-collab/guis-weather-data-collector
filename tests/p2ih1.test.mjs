import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "./deployment.test.mjs";
import { buildRunObjects, publishDataset } from "../src/publisher.mjs";
import { validateIndexManifest, validateIndexTile } from "../src/indexes.mjs";
import { LocalObjectStore } from "../src/object-store.mjs";
import { parseJson } from "../src/contracts.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));

function koreaGridFixture() {
  const dataset = fixture();
  const points = [];
  for (let row = 0; row < 31; row += 1) {
    for (let column = 0; column < 31; column += 1) {
      points.push({ id: row * 31 + column, latitude: 32 + row * 0.25, longitude: 124.5 + column * 0.25 });
    }
  }
  dataset.grid = { type: "regular_ll", Ni: 31, Nj: 31, resolutionDegrees: 0.25, points };
  for (const frame of dataset.frames) {
    frame.values = points.map((point) => point.id === 0
      ? { pointId: point.id, rawValue: null, quantitativeValue: null, status: "MISSING" }
      : point.id === 1 ? { pointId: point.id, rawValue: "0", quantitativeValue: 0, status: "AVAILABLE" }
        : { pointId: point.id, rawValue: "0.25", quantitativeValue: 0.25, status: "AVAILABLE" });
    frame.statistics = { availableCount: 960, missingCount: 1, zeroCount: 1, positiveCount: 959, minimum: 0, maximum: 0.25 };
  }
  return dataset;
}

test("31 by 31 grid builds sixteen deterministic 8 by 8 tile indexes", () => {
  const first = buildRunObjects(koreaGridFixture());
  const second = buildRunObjects(koreaGridFixture());
  assert.equal(first.indexPlan.tileObjects.length, 16);
  assert.equal(first.indexPlan.manifest.tileSize, 8);
  assert.equal(first.indexPlan.manifest.grid.pointCount, 961);
  assert.equal(first.indexPlan.manifest.sourceManifest.sha256, first.manifestObject.sha256);
  assert.equal(first.indexPlan.manifestObject.sha256, second.indexPlan.manifestObject.sha256);
  assert.deepEqual(first.indexPlan.tileObjects.map((item) => item.sha256), second.indexPlan.tileObjects.map((item) => item.sha256));
});

test("tile index preserves zero missing and independent f012 PT6H and PT12H contracts", () => {
  const plan = buildRunObjects(koreaGridFixture());
  const descriptor = plan.indexPlan.tileObjects[0];
  const tile = parseJson(descriptor.body);
  validateIndexTile(tile, { runId: plan.runId, sourceManifest: plan.latest.manifest,
    descriptor, contractCount: plan.forecastObjects.length });
  const periods = tile.contracts.filter((item) => item.forecastHour === 12).map((item) => item.accumulationPeriod).sort();
  assert.deepEqual(periods, ["PT12H", "PT6H"]);
  assert.equal(tile.points.find((point) => point.pointId === 0).values.every((value) => value.status === "MISSING"), true);
  assert.equal(tile.points.find((point) => point.pointId === 1).values.every((value) => value.quantitativeValue === 0), true);
  assert.equal(tile.contracts.every((item) => item.sourceShard.key.includes("/forecasts/") && /^[a-f0-9]{64}$/.test(item.sourceShard.sha256)), true);
});

test("index manifest mismatch and point overlap fail closed", () => {
  const plan = buildRunObjects(koreaGridFixture());
  assert.throws(() => validateIndexManifest({ ...structuredClone(plan.indexPlan.manifest),
    sourceManifest: { ...plan.latest.manifest, sha256: "0".repeat(64) }
  }, { runId: plan.runId, sourceManifest: plan.latest.manifest }), /SOURCE_MANIFEST_MISMATCH/);
  const duplicate = structuredClone(plan.indexPlan.manifest);
  duplicate.tiles[1].pointIds[0] = duplicate.tiles[0].pointIds[0];
  assert.throws(() => validateIndexManifest(duplicate, { runId: plan.runId, sourceManifest: plan.latest.manifest }), /POINT_MAP_INVALID/);
});

test("publisher writes every tile and index manifest before the immutable source manifest and latest", async () => {
  const root = await mkdtemp(join(tmpdir(), "gfs-index-order-"));
  const store = new LocalObjectStore(root);
  const writes = [];
  const tracking = new Proxy(store, {
    get(target, property) {
      if (property === "put") return async (key, ...args) => { writes.push(key); return target.put(key, ...args); };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  try {
    const result = await publishDataset(tracking, koreaGridFixture());
    const indexManifestPosition = writes.indexOf(`runs/${result.runId}/indexes/v1/manifest.json`);
    const sourceManifestPosition = writes.indexOf(`runs/${result.runId}/manifest.json`);
    assert.ok(indexManifestPosition > writes.findLastIndex((key) => key.includes("/indexes/v1/tiles/")));
    assert.ok(sourceManifestPosition > indexManifestPosition);
    assert.equal(writes.at(-1), "latest.json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manual index backfill workflow contains no NOAA collection or schedule path", async () => {
  const [workflow, backfill, publisher] = await Promise.all([
    readFile(join(here, "../.github/workflows/backfill-gfs-index.yml"), "utf8"),
    readFile(join(here, "../scripts/backfill-index.mjs"), "utf8"),
    readFile(join(here, "../scripts/publish-index-r2.mjs"), "utf8")
  ]);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /schedule:|collect-and-publish|nomads|downloadFrame/);
  assert.match(workflow, /publish-index-r2\.mjs/);
  assert.match(backfill, /buildIndexesFromPublishedStore/);
  assert.match(publisher, /R2_INDEX_SOURCE_MANIFEST_MISMATCH/);
  assert.doesNotMatch(publisher, /latest\.json.*put-object|NOMADS|downloadFrame/);
});
