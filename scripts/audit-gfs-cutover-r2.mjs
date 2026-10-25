import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJson, sha256 } from "../src/contracts.mjs";
import { compareSameRunOfficialContracts } from "../src/cutover-readiness.mjs";
import { buildOperationalRetentionDryRun } from "../src/operational-retention.mjs";
import { r2Args, runAws, verifiedR2Environment } from "../src/r2-cli.mjs";

if (!process.argv.includes("--execute")) throw new Error("GFS_CUTOVER_REMOTE_EXECUTION_FLAG_REQUIRED");
verifiedR2Environment();
const temporary = await mkdtemp(join(tmpdir(), "gfs-cutover-audit-"));
const reportPath = join(process.cwd(), "artifacts", "cutover-audit.json");

async function remoteGet(key) {
  if (typeof key !== "string" || !key || /[\r\n]/.test(key)) throw new Error("GFS_CUTOVER_R2_KEY_INVALID");
  const target = join(temporary, `${sha256(Buffer.from(key))}.json`);
  const result = await runAws(r2Args("get-object", ["--key", key, target]), { allowFailure: true });
  if (result.code !== 0 && result.failureKind === "NOT_FOUND") return null;
  if (result.code !== 0) throw new Error("GFS_CUTOVER_R2_READ_FAILED");
  const body = await readFile(target);
  return { key, body, value: parseJson(body, "GFS_CUTOVER_R2_JSON_INVALID") };
}

async function remoteDescriptor(descriptor) {
  if (!descriptor || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1
    || !/^[a-f0-9]{64}$/.test(descriptor.sha256 || "")) throw new Error("GFS_CUTOVER_DESCRIPTOR_INVALID");
  const object = await remoteGet(descriptor.key);
  if (!object || object.body.byteLength !== descriptor.bytes || sha256(object.body) !== descriptor.sha256) {
    throw new Error("GFS_CUTOVER_OBJECT_INTEGRITY_FAILED");
  }
  return object;
}

async function listInventory() {
  const objects = [];
  let token = null;
  do {
    const args = ["--max-keys", "1000"];
    if (token) args.push("--continuation-token", token);
    const result = await runAws(r2Args("list-objects-v2", args));
    const page = parseJson(Buffer.from(result.stdout), "GFS_CUTOVER_INVENTORY_INVALID");
    for (const item of page.Contents || []) {
      const size = Number(item.Size);
      if (typeof item.Key !== "string" || !Number.isSafeInteger(size) || size < 0) throw new Error("GFS_CUTOVER_INVENTORY_ITEM_INVALID");
      objects.push({ key: item.Key, size, lastModified: item.LastModified || null });
    }
    token = page.IsTruncated ? page.NextContinuationToken : null;
    if (page.IsTruncated && !token) throw new Error("GFS_CUTOVER_INVENTORY_TOKEN_MISSING");
  } while (token);
  return objects;
}

function runIdentity(key) {
  let match = key.match(/^runs\/(\d{8}T\d{6}Z)\//);
  if (match) return { namespace: "48H", runId: match[1] };
  match = key.match(/^horizons\/144h\/runs\/(\d{8}T\d{6}Z)\//);
  return match ? { namespace: "144H", runId: match[1] } : null;
}

function runManifestKey(namespace, runId) {
  return namespace === "48H" ? `runs/${runId}/manifest.json` : `horizons/144h/runs/${runId}/manifest.json`;
}

async function mapLimit(values, limit, operation) {
  const output = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next;
      next += 1;
      output[index] = await operation(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return output;
}

try {
  const inventory = await listInventory();
  const [latest48Object, latest144Object, canaryObject] = await Promise.all([
    remoteGet("latest.json"),
    remoteGet("horizons/144h/latest.json"),
    remoteGet("horizons/144h/status/canary.json")
  ]);
  if (!latest48Object || !latest144Object) throw new Error("GFS_CUTOVER_LATEST_POINTER_MISSING");
  const latest48 = latest48Object.value;
  const latest144 = latest144Object.value;
  const grouped = new Map();
  for (const object of inventory) {
    const identity = runIdentity(object.key);
    if (!identity) continue;
    const id = `${identity.namespace}:${identity.runId}`;
    const group = grouped.get(id) || { ...identity, objectCount: 0, bytes: 0, objects: [] };
    group.objectCount += 1;
    group.bytes += object.size;
    group.objects.push(object.key);
    grouped.set(id, group);
  }
  const manifests = new Map();
  for (const group of grouped.values()) {
    const key = runManifestKey(group.namespace, group.runId);
    const object = await remoteGet(key);
    if (!object) continue;
    const manifest = object.value;
    const complete = manifest.status === "COMPLETE" && manifest.runId === group.runId
      && (group.namespace === "48H" ? !manifest.namespace : manifest.namespace === "horizons/144h");
    manifests.set(`${group.namespace}:${group.runId}`, { object, manifest, complete });
  }
  const commonRunIds = [...new Set([...grouped.values()].filter((item) => item.namespace === "48H").map((item) => item.runId))]
    .filter((runId) => manifests.get(`48H:${runId}`)?.complete && manifests.get(`144H:${runId}`)?.complete)
    .sort().reverse();
  if (!commonRunIds.length) throw new Error("GFS_CUTOVER_SAME_MODEL_RUN_NOT_FOUND");
  const comparisonRunId = commonRunIds[0];
  const manifest48 = manifests.get(`48H:${comparisonRunId}`).manifest;
  const manifest144 = manifests.get(`144H:${comparisonRunId}`).manifest;
  const [grid48Object, grid144Object] = await Promise.all([
    remoteDescriptor(manifest48.grid),
    remoteDescriptor(manifest144.grid)
  ]);
  const selected48 = manifest48.forecasts.filter((item) => item.forecastHour >= 1 && item.forecastHour <= 48);
  const selected144 = manifest144.forecasts.filter((item) => item.forecastHour >= 1 && item.forecastHour <= 48);
  const [downloaded48, downloaded144] = await Promise.all([
    mapLimit(selected48, 8, remoteDescriptor),
    mapLimit(selected144, 8, remoteDescriptor)
  ]);
  const shards48 = new Map(downloaded48.map((item) => [item.value.frameId, item.value]));
  const shards144 = new Map(downloaded144.map((item) => [item.value.frameId, item.value]));
  const comparison = compareSameRunOfficialContracts({ manifest48, manifest144,
    grid48: grid48Object.value, grid144: grid144Object.value, shards48, shards144 });

  const runs = [...grouped.values()].map((group) => {
    const manifest = manifests.get(`${group.namespace}:${group.runId}`);
    return {
      namespace: group.namespace,
      runId: group.runId,
      modelRunAt: manifest?.manifest?.modelRunAt || `${group.runId.slice(0, 4)}-${group.runId.slice(4, 6)}-${group.runId.slice(6, 8)}T${group.runId.slice(9, 11)}:${group.runId.slice(11, 13)}:${group.runId.slice(13, 15)}.000Z`,
      objectCount: group.objectCount,
      bytes: group.bytes,
      complete: manifest?.complete === true,
      manifestKey: runManifestKey(group.namespace, group.runId)
    };
  });
  const currentBytes = inventory.reduce((sum, item) => sum + item.size, 0);
  const canary144RunIds = [...new Set((canaryObject?.value?.successfulPublications || [])
    .map((item) => item?.runId).filter((runId) => /^\d{8}T\d{6}Z$/.test(runId || "")))];
  const rollback48RunId = /^\d{8}T\d{6}Z$/.test(process.env.GFS_ROLLBACK_48_RUN_ID || "")
    ? process.env.GFS_ROLLBACK_48_RUN_ID : latest48.runId;
  const retention = buildOperationalRetentionDryRun({ runs, latest48RunId: latest48.runId,
    latest144RunId: latest144.runId, currentBytes, rollback48RunId, canary144RunIds });
  const report = {
    status: "GFS_CUTOVER_AUDIT_PASS",
    generatedAt: new Date().toISOString(),
    bucket: "guis-weather-gfs-preview",
    latest48: { runId: latest48.runId, modelRunAt: latest48.modelRunAt, latestValidAt: latest48.latestValidAt,
      coverage: latest48.coverage, sha256: sha256(latest48Object.body) },
    latest144: { runId: latest144.runId, modelRunAt: latest144.modelRunAt, latestValidAt: latest144.latestValidAt,
      coverage: latest144.coverage, sha256: sha256(latest144Object.body) },
    comparison,
    inventory: { objectCount: inventory.length, totalBytes: currentBytes,
      namespace48Bytes: runs.filter((item) => item.namespace === "48H").reduce((sum, item) => sum + item.bytes, 0),
      namespace144Bytes: runs.filter((item) => item.namespace === "144H").reduce((sum, item) => sum + item.bytes, 0) },
    runs,
    retention
  };
  await mkdir(join(process.cwd(), "artifacts"), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
    `comparison_status=${comparison.status}\ncomparison_run_id=${comparison.runId}\ncontract_count=${comparison.contractCount}\n`
      + `grid_point_count=${comparison.gridPointCount}\nvalue_count=${comparison.valueCount}\nr2_object_count=${inventory.length}\n`
      + `r2_total_bytes=${currentBytes}\nretention_candidate_count=${retention.deleteCandidates.length}\n`
      + `retention_candidate_bytes=${retention.candidateBytes}\nsoft_stop_days=${retention.estimatedDaysToSoftStopWithoutRetention ?? ""}\n`, "utf8");
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `## GFS 48H/144H cutover audit\n- comparison: ${comparison.status}\n- same run: ${comparison.modelRunAt}\n`
      + `- official contracts: ${comparison.contractCount}\n- grid points: ${comparison.gridPointCount}\n- values compared: ${comparison.valueCount}\n`
      + `- R2 objects/bytes: ${inventory.length} / ${currentBytes}\n- retention dry-run candidates: ${retention.deleteCandidates.length} runs / ${retention.candidateBytes} bytes\n`
      + `- deletion executed: false\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
