import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runBounded, runPublishStages } from "../src/bounded-publisher.mjs";
import { validatePublishSource144 } from "../src/publish-source-144.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("bounded publisher never exceeds its small concurrency limit", async () => {
  let active = 0;
  let maximum = 0;
  await runBounded(Array.from({ length: 24 }, (_, index) => index), 4, async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await sleep(3);
    active -= 1;
  });
  assert.equal(maximum, 4);
});

test("staged publishing reuses partial objects and keeps publication and latest last", async () => {
  const order = [];
  const stages = [
    { name: "data", items: ["data-a", "data-b"] },
    { name: "manifest", items: ["manifest"], serial: true },
    { name: "publication", items: ["publication"], serial: true },
    { name: "latest", items: ["latest"], serial: true }
  ];
  const result = await runPublishStages(stages, { concurrency: 2, progressEvery: 1,
    publishObject: async (key) => { order.push(key); return key === "data-a" ? "reused" : "uploaded"; } });
  assert.equal(result.reused, 1);
  assert.equal(result.uploaded, 4);
  assert.ok(order.indexOf("manifest") > order.indexOf("data-a"));
  assert.ok(order.indexOf("publication") > order.indexOf("manifest"));
  assert.equal(order.at(-1), "latest");
});

test("a dependency failure prevents publication and latest transition", async () => {
  const order = [];
  await assert.rejects(runPublishStages([
    { name: "data", items: ["data"] },
    { name: "manifest", items: ["bad-manifest"], serial: true },
    { name: "publication", items: ["publication"], serial: true },
    { name: "latest", items: ["latest"], serial: true }
  ], { publishObject: async (key) => {
    order.push(key);
    if (key === "bad-manifest") throw new Error("REMOTE_SHA_MISMATCH");
    return "uploaded";
  } }), /REMOTE_SHA_MISMATCH/);
  assert.deepEqual(order, ["data", "bad-manifest"]);
});

test("a latest race detected immediately before the swap prevents the pointer write", async () => {
  const order = [];
  await assert.rejects(runPublishStages([
    { name: "data", items: ["data"] },
    { name: "publication", items: ["publication"], serial: true },
    { name: "latest", items: ["latest"], serial: true }
  ], {
    publishObject: async (key) => { order.push(key); return "uploaded"; },
    beforeStage: async (stage) => {
      if (stage.name === "latest") throw new Error("R2_144H_LATEST_RACE");
    }
  }), /R2_144H_LATEST_RACE/);
  assert.deepEqual(order, ["data", "publication"]);
});

test("publish-only source accepts a cancelled operational run only when collect and Artifact are exact", () => {
  const run = { id: 41248546631, repository: { full_name: "gamzagui-collab/guis-weather-data-collector" },
    path: ".github/workflows/collect-gfs-144h-operational.yml", event: "schedule", head_branch: "main",
    status: "completed", conclusion: "cancelled", head_sha: "b".repeat(40) };
  const jobs = [{ name: "collect-and-publish / collect", status: "completed", conclusion: "success" }];
  const artifacts = [{ id: 13061566053, name: "gfs-144h-20261031T180000Z", expired: false,
    workflow_run: { id: run.id, head_sha: run.head_sha } }];
  const result = validatePublishSource144({ repository: run.repository.full_name, run, jobs, artifacts,
    expectedRunId: String(run.id), expectedArtifactId: String(artifacts[0].id) });
  assert.equal(result.artifactName, artifacts[0].name);
  assert.throws(() => validatePublishSource144({ repository: run.repository.full_name, run,
    jobs: [{ ...jobs[0], conclusion: "failure" }], artifacts, expectedRunId: String(run.id),
    expectedArtifactId: String(artifacts[0].id) }), /SOURCE_RUN_INVALID/);
});

test("remote publisher is bounded, deletion-free and publish-only workflow never collects NOAA", async () => {
  const [publisher, workflow] = await Promise.all([
    readFile(new URL("../scripts/publish-r2-144h.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/publish-gfs-144h-artifact.yml", import.meta.url), "utf8")
  ]);
  assert.match(publisher, /const PUBLISH_CONCURRENCY = 8/);
  assert.match(publisher, /runPublishStages/);
  assert.doesNotMatch(publisher, /delete-object/);
  assert.match(workflow, /guis-weather-gfs-r2-publisher/);
  assert.match(workflow, /verify-publish-source-144h\.mjs/);
  assert.doesNotMatch(workflow, /collect-and-publish\.mjs|--live/);
});
