import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicationArtifact, verifyPublicationArtifact } from "../src/artifact.mjs";
import { createArtifactPreflight, verifyArtifactPreflight } from "../src/artifact-preflight.mjs";
import { LocalObjectStore } from "../src/object-store.mjs";
import { publishDataset } from "../src/publisher.mjs";
import { PREVIEW_BUCKET, verifiedR2Environment } from "../src/r2-cli.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const provenance = {
  repository: "gamzagui-collab/guis-weather-data-collector",
  ref: "main",
  commit: "a".repeat(40),
  workflowRunId: "123456789"
};

function fixture(modelRunAt = "2026-10-22T06:00:00Z") {
  const run = new Date(modelRunAt);
  const at = (hours) => new Date(run.valueOf() + hours * 3_600_000).toISOString().replace(".000Z", "Z");
  const points = [{ id: 0, latitude: 35.75, longitude: 127 }];
  const frame = (forecastHour, start, period, marker) => ({
    messageIndex: 1,
    messageSha256: marker.repeat(64),
    sourceDataSha256: marker.repeat(64),
    sourceFile: `f${String(forecastHour).padStart(3, "0")}.grib2`,
    modelRunAt,
    validAt: at(forecastHour),
    forecastHour,
    accumulationStart: at(start),
    accumulationEnd: at(forecastHour),
    accumulationPeriod: period,
    stepRange: `${start}-${forecastHour}`,
    sourceUnit: "kg m**-2",
    unit: "mm",
    conversion: "1 kg m-2 liquid-water equivalent = 1 mm",
    packing: { packingType: "grid_simple", bitsPerValue: 4 },
    values: [{ pointId: 0, rawValue: "0", quantitativeValue: 0, status: "AVAILABLE" }],
    statistics: { availableCount: 1, missingCount: 0, zeroCount: 1, positiveCount: 0, minimum: 0, maximum: 0 }
  });
  return {
    schemaVersion: "weather.gfs.grid.v1",
    provider: "NOAA/NCEP",
    model: "GFS",
    broker: null,
    source: "NOAA/NCEP NOMADS",
    sourceUrl: "https://nomads.ncep.noaa.gov/",
    product: "GFS 0.25 degree GRIB2 surface APCP",
    variable: "precipitation",
    modelRunAt,
    publishedAt: null,
    fetchedAt: at(0),
    sourceUnit: "kg m**-2",
    unit: "mm",
    area: { name: "Republic of Korea", bounds: { left: 124.5, right: 132, bottom: 32, top: 39.5 } },
    grid: { type: "regular_ll", Ni: 1, Nj: 1, resolutionDegrees: 0.25, points },
    frames: [frame(1, 0, "PT1H", "a"), frame(3, 0, "PT3H", "b"), frame(6, 0, "PT6H", "c"),
      frame(12, 0, "PT12H", "d"), frame(12, 6, "PT6H", "e")],
    duplicateMessagesRemoved: [],
    missingForecastHours: [],
    status: "AVAILABLE"
  };
}

async function artifactFixture() {
  const root = await mkdtemp(join(tmpdir(), "gfs-artifact-test-"));
  const storeRoot = join(root, "store");
  const artifactRoot = join(root, "artifact");
  await publishDataset(new LocalObjectStore(storeRoot), fixture());
  return { root, storeRoot, artifactRoot, close: () => rm(root, { recursive: true, force: true }) };
}

test("verified artifact contains all nine publication objects and both f012 contracts", async () => {
  const holder = await artifactFixture();
  try {
    const created = await createPublicationArtifact({ storeRoot: holder.storeRoot, artifactRoot: holder.artifactRoot, provenance });
    assert.equal(created.objectCount, 9);
    const verified = await verifyPublicationArtifact({ artifactRoot: holder.artifactRoot, expected: provenance });
    assert.equal(verified.manifest.forecasts.length, 5);
    const periods = verified.manifest.forecasts.filter((item) => item.forecastHour === 12).map((item) => item.accumulationPeriod);
    assert.deepEqual(new Set(periods), new Set(["PT12H", "PT6H"]));
  } finally { await holder.close(); }
});

test("tampered artifact and mismatched workflow provenance are rejected", async () => {
  const holder = await artifactFixture();
  try {
    const created = await createPublicationArtifact({ storeRoot: holder.storeRoot, artifactRoot: holder.artifactRoot, provenance });
    await assert.rejects(() => verifyPublicationArtifact({ artifactRoot: holder.artifactRoot, expected: { ...provenance, workflowRunId: "999" } }), /MISMATCH/);
    await writeFile(join(holder.artifactRoot, "payload", created.objects[0].key), "{}\n", "utf8");
    await assert.rejects(() => verifyPublicationArtifact({ artifactRoot: holder.artifactRoot, expected: provenance }), /INTEGRITY_FAILED/);
  } finally { await holder.close(); }
});

test("artifact file allowlist rejects injected files", async () => {
  const holder = await artifactFixture();
  try {
    await createPublicationArtifact({ storeRoot: holder.storeRoot, artifactRoot: holder.artifactRoot, provenance });
    await writeFile(join(holder.artifactRoot, "payload", "unexpected.json"), "{}\n", "utf8");
    await assert.rejects(() => verifyPublicationArtifact({ artifactRoot: holder.artifactRoot, expected: provenance }), /FILE_SET_INVALID/);
  } finally { await holder.close(); }
});

test("R2 configuration is exact-bucket and validates secret formats without exposing values", () => {
  const env = {
    R2_ACCOUNT_ID: "1".repeat(32),
    R2_ACCESS_KEY_ID: "2".repeat(32),
    R2_SECRET_ACCESS_KEY: "3".repeat(64),
    R2_BUCKET: PREVIEW_BUCKET
  };
  const result = verifiedR2Environment(env);
  assert.equal(result.bucket, PREVIEW_BUCKET);
  assert.equal(result.endpoint, `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
  assert.throws(() => verifiedR2Environment({ ...env, R2_ACCESS_KEY_ID: "x".repeat(39) }), /ACCESS_KEY_ID_FORMAT_INVALID/);
  assert.throws(() => verifiedR2Environment({ ...env, R2_BUCKET: "production" }), /BUCKET_NOT_ALLOWED/);
});

test("preflight, collection, and publication workflows remain separated and manual-only", async () => {
  const collect = await readFile(join(here, "../.github/workflows/collect-gfs.yml"), "utf8");
  const publish = await readFile(join(here, "../.github/workflows/publish-gfs.yml"), "utf8");
  const preflight = await readFile(join(here, "../.github/workflows/r2-preflight.yml"), "utf8");
  const artifactPreflight = await readFile(join(here, "../.github/workflows/artifact-preflight.yml"), "utf8");
  for (const workflow of [collect, publish, preflight, artifactPreflight]) {
    assert.match(workflow, /workflow_dispatch:/);
    assert.doesNotMatch(workflow, /schedule:|pull_request:/);
    assert.match(workflow, /contents: read/);
  }
  assert.match(collect, /actions\/upload-artifact@v4/);
  assert.match(collect, /GFS_ARTIFACT_ROOT: artifact-package/);
  assert.match(collect, /path: artifact-package/);
  assert.doesNotMatch(collect, /path: \.artifact/);
  assert.doesNotMatch(collect, /R2_|SECRET_ACCESS_KEY|publish-r2/);
  assert.match(publish, /actions: read/);
  assert.match(publish, /actions\/download-artifact@v4/);
  assert.match(publish, /GFS_ARTIFACT_ROOT: artifact-package/);
  assert.match(publish, /collect-gfs\.yml/);
  assert.match(publish, /run\.head_branch !== "main"/);
  assert.doesNotMatch(publish, /collect-and-publish|src\/noaa|nomads\.ncep/);
  assert.match(preflight, /scripts\/r2-canary\.mjs --execute/);
  assert.doesNotMatch(preflight, /collect-and-publish|src\/noaa|nomads\.ncep/);
  assert.match(artifactPreflight, /path: artifact-package/);
  assert.match(artifactPreflight, /if-no-files-found: error/);
  assert.match(artifactPreflight, /retention-days: 3/);
  assert.match(artifactPreflight, /gfs-artifact-preflight-\$\{\{ github\.run_id \}\}/);
  assert.doesNotMatch(artifactPreflight, /collect-and-publish|src\/noaa|nomads\.ncep|R2_/);
});

test("artifact preflight round-trip fixes the exact downloaded directory structure and SHA-256", async () => {
  const root = await mkdtemp(join(tmpdir(), "gfs-artifact-preflight-test-"));
  try {
    const created = await createArtifactPreflight({ root, runId: provenance.workflowRunId, commit: provenance.commit });
    const verified = await verifyArtifactPreflight({ root, runId: provenance.workflowRunId, commit: provenance.commit });
    assert.deepEqual(verified.files, ["metadata.json", "payload/preflight/canary.json"]);
    assert.equal(verified.sha256, created.sha256);
    assert.equal(verified.bytes, created.bytes);
    await writeFile(join(root, "payload", "preflight", "canary.json"), "{}\n", "utf8");
    await assert.rejects(() => verifyArtifactPreflight({ root, runId: provenance.workflowRunId, commit: provenance.commit }), /MISMATCH|INTEGRITY/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("canary contract performs put, head, get, hash, delete, and absence verification", async () => {
  const source = await readFile(join(here, "../scripts/r2-canary.mjs"), "utf8");
  for (const action of ["put-object", "head-object", "get-object", "delete-object"]) assert.match(source, new RegExp(action));
  assert.match(source, /sha256\(received\)/);
  assert.match(source, /DELETE_NOT_CONFIRMED/);
  assert.doesNotMatch(source, /console\.log\(process\.env|ACCESS_KEY_ID.*stdout|SECRET_ACCESS_KEY.*stdout/);
});

test("publisher verifies remote bodies, blocks latest regression, writes latest last, and reuses exact objects", async () => {
  const source = await readFile(join(here, "../scripts/publish-r2.mjs"), "utf8");
  assert.match(source, /R2_LATEST_REGRESSION_BLOCKED/);
  assert.match(source, /R2_REMOTE_BODY_INTEGRITY_FAILED/);
  assert.match(source, /ordered = \[\.\.\.descriptors/);
  assert.match(source, /LATEST_KEY\]/);
  assert.match(source, /R2_IMMUTABLE_OBJECT_CONFLICT/);
  assert.match(source, /reusedCount/);
  assert.match(source, /exactRemote/);
  assert.doesNotMatch(source, /collect-and-publish|src\/noaa|nomads\.ncep/);
});
