import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJson, sha256 } from "../src/contracts.mjs";
import { indexManifestKey, validateIndexManifest } from "../src/indexes.mjs";
import { LATEST_KEY } from "../src/publisher.mjs";
import { r2Args, runAws, verifiedR2Environment } from "../src/r2-cli.mjs";
import { evaluateStorageProtection } from "../src/storage-policy.mjs";

if (!process.argv.includes("--execute")) throw new Error("R2_REMOTE_EXECUTION_FLAG_REQUIRED");
verifiedR2Environment();
const temporary = await mkdtemp(join(tmpdir(), "gfs-r2-inspect-"));

async function remoteGet(key, name) {
  const target = join(temporary, name);
  const result = await runAws(r2Args("get-object", ["--key", key, target]), { allowFailure: true });
  if (result.code !== 0 && result.failureKind === "NOT_FOUND") return null;
  if (result.code !== 0) throw new Error("R2_PUBLICATION_READ_FAILED");
  const body = await readFile(target);
  return { body, value: parseJson(body, "R2_PUBLICATION_JSON_INVALID") };
}

async function remoteHeadMatches(descriptor) {
  const result = await runAws(r2Args("head-object", ["--key", descriptor.key]), { allowFailure: true });
  if (result.code !== 0 && result.failureKind === "NOT_FOUND") return false;
  if (result.code !== 0) throw new Error("R2_PUBLICATION_HEAD_FAILED");
  const value = parseJson(Buffer.from(result.stdout), "R2_PUBLICATION_HEAD_INVALID");
  return Number(value.ContentLength) === descriptor.bytes && value.Metadata?.sha256 === descriptor.sha256;
}

async function inventory() {
  let token = null;
  let objectCount = 0;
  let totalBytes = 0;
  do {
    const args = ["--max-keys", "1000"];
    if (token) args.push("--continuation-token", token);
    const result = await runAws(r2Args("list-objects-v2", args));
    const page = parseJson(Buffer.from(result.stdout), "R2_INVENTORY_INVALID");
    for (const item of page.Contents || []) {
      if (!Number.isSafeInteger(Number(item.Size)) || Number(item.Size) < 0) throw new Error("R2_INVENTORY_SIZE_INVALID");
      objectCount += 1;
      totalBytes += Number(item.Size);
    }
    token = page.IsTruncated ? page.NextContinuationToken : null;
    if (page.IsTruncated && !token) throw new Error("R2_INVENTORY_TOKEN_MISSING");
  } while (token);
  return { objectCount, totalBytes };
}

try {
  const usage = await inventory();
  const storage = evaluateStorageProtection({ currentBytes: usage.totalBytes });
  if (storage.status !== "ALLOW") throw new Error(storage.reason);
  const latestObject = await remoteGet(LATEST_KEY, "latest.json");
  let publishedComplete = false;
  let latest = null;
  let manifestSha256 = null;
  let indexManifestSha256 = null;
  let latestSha256 = null;
  if (latestObject) {
    latest = latestObject.value;
    latestSha256 = sha256(latestObject.body);
    const manifestObject = await remoteGet(latest.manifest?.key, "manifest.json");
    if (!manifestObject || manifestObject.body.byteLength !== latest.manifest?.bytes
      || sha256(manifestObject.body) !== latest.manifest?.sha256
      || manifestObject.value.status !== "COMPLETE" || manifestObject.value.runId !== latest.runId) {
      throw new Error("R2_SOURCE_MANIFEST_INTEGRITY_FAILED");
    }
    manifestSha256 = sha256(manifestObject.body);
    const indexObject = await remoteGet(indexManifestKey(latest.runId), "index-manifest.json");
    if (!indexObject) throw new Error("R2_INDEX_MANIFEST_MISSING");
    validateIndexManifest(indexObject.value, { runId: latest.runId, sourceManifest: latest.manifest });
    indexManifestSha256 = sha256(indexObject.body);
    const descriptors = [manifestObject.value.grid, ...manifestObject.value.forecasts,
      ...indexObject.value.tiles, latest.manifest,
      { key: indexManifestKey(latest.runId), bytes: indexObject.body.byteLength, sha256: indexManifestSha256 }];
    const matches = await Promise.all(descriptors.map(remoteHeadMatches));
    if (matches.some((value) => !value)) throw new Error("R2_PUBLISHED_OBJECT_INTEGRITY_FAILED");
    publishedComplete = true;
  }
  const result = {
    status: "R2_PUBLICATION_INSPECTED",
    publishedComplete,
    runId: latest?.runId || null,
    modelRunAt: latest?.modelRunAt || null,
    latestValidAt: latest?.latestValidAt || null,
    latestSha256,
    manifestSha256,
    indexManifestSha256,
    objectCount: usage.objectCount,
    totalBytes: usage.totalBytes,
    storage
  };
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT,
      `published_complete=${publishedComplete}\npublished_model_run_at=${result.modelRunAt || ""}\n`
      + `published_run_id=${result.runId || ""}\nr2_object_count=${usage.objectCount}\nr2_total_bytes=${usage.totalBytes}\n`
      + `latest_sha256=${latestSha256 || ""}\nmanifest_sha256=${manifestSha256 || ""}\n`
      + `index_manifest_sha256=${indexManifestSha256 || ""}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

