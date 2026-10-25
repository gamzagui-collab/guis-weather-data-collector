import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("permanent 144H workflows are complete but inert until every cutover gate passes", async () => {
  const [collector, monitor, manual] = await Promise.all([
    read(".github/workflows/collect-gfs-144h-operational.yml.disabled"),
    read(".github/workflows/monitor-gfs-144h-operational.yml.disabled"),
    read(".github/workflows/collect-gfs-144h-manual.yml")
  ]);
  assert.match(collector, /17 7,19 \* \* \*/);
  assert.match(collector, /guis-weather-gfs-noaa-collection/);
  assert.match(collector, /collect-gfs-144h-manual\.yml/);
  assert.match(collector, /secrets: inherit/);
  assert.match(manual, /workflow_call:/);
  assert.match(manual, /GFS_MAX_REQUESTS: "135"/);
  assert.match(manual, /GFS_MAX_DOWNLOAD_BYTES: "20971520"/);
  assert.match(manual, /publish-r2-144h\.mjs/);
  assert.match(monitor, /collect-gfs-144h-operational\.yml/);
  assert.match(monitor, /event === "schedule"/);
  assert.match(monitor, /FRESH/);
  assert.match(monitor, /DELAYED/);
  assert.match(monitor, /STALE/);
  assert.match(monitor, /lastManual/);
});

test("active Canary limits and existing 48H schedule remain unchanged", async () => {
  const [canary, monitor, active48] = await Promise.all([
    read(".github/workflows/collect-gfs-144h-canary.yml"),
    read(".github/workflows/monitor-gfs-144h.yml"),
    read(".github/workflows/collect-gfs-automatic.yml")
  ]);
  assert.match(canary, /GFS_144H_CANARY_PUBLICATION_LIMIT: "2"/);
  assert.match(canary, /GFS_144H_CANARY_EXPIRES_AT: "2026-10-27T06:45:00Z"/);
  assert.match(canary, /17 7,19 \* \* \*/);
  assert.match(monitor, /Monitor GFS 144H Canary Freshness/);
  assert.match(active48, /37 5,11,17,23 \* \* \*/);
});

test("operational artifacts are trusted without expanding repository or event trust", async () => {
  const source = await read("scripts/collect-and-publish.mjs");
  assert.match(source, /collect-gfs-144h-operational\.yml/);
  assert.match(source, /previousRun\.repository\?\.full_name === repository/);
  assert.match(source, /previousRun\.head_branch === "main"/);
  assert.match(source, /new Set\(\["workflow_dispatch", "schedule"\]\)/);
});
