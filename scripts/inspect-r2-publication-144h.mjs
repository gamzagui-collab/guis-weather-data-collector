import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJson, sha256 } from "../src/contracts.mjs";
import { GFS_144H_NAMESPACE } from "../src/horizon-144.mjs";
import { indexV2ManifestKey, validateIndexV2Manifest } from "../src/indexes-v2.mjs";
import { LATEST_144H_KEY } from "../src/publisher-144.mjs";
import { r2Args, runAws, verifiedR2Environment } from "../src/r2-cli.mjs";
import { evaluateStorageProtection } from "../src/storage-policy.mjs";

if (!process.argv.includes("--execute")) throw new Error("R2_144H_REMOTE_EXECUTION_FLAG_REQUIRED");
verifiedR2Environment();
const temporary = await mkdtemp(join(tmpdir(), "gfs-r2-144h-inspect-"));

async function remoteGet(key, name) {
  const target = join(temporary, name);
  const result = await runAws(r2Args("get-object", ["--key", key, target]), { allowFailure: true });
  if (result.code !== 0 && result.failureKind === "NOT_FOUND") return null;
  if (result.code !== 0) throw new Error("R2_144H_PUBLICATION_READ_FAILED");
  const body = await readFile(target);
  return { body, value: parseJson(body, "R2_144H_PUBLICATION_JSON_INVALID") };
}

async function remoteHeadMatches(descriptor) {
  if (!descriptor.key.startsWith(`${GFS_144H_NAMESPACE}/`)) throw new Error("R2_144H_NAMESPACE_ESCAPE");
  const result = await runAws(r2Args("head-object", ["--key", descriptor.key]), { allowFailure: true });
  if (result.code !== 0 && result.failureKind === "NOT_FOUND") return false;
  if (result.code !== 0) throw new Error("R2_144H_PUBLICATION_HEAD_FAILED");
  const value = parseJson(Buffer.from(result.stdout), "R2_144H_PUBLICATION_HEAD_INVALID");
  return Number(value.ContentLength) === descriptor.bytes && value.Metadata?.sha256 === descriptor.sha256;
}

async function inventory() {
  let token = null;
  let bucketObjectCount = 0;
  let bucketTotalBytes = 0;
  let namespaceObjectCount = 0;
  let namespaceTotalBytes = 0;
  do {
    const args = ["--max-keys", "1000"];
    if (token) args.push("--continuation-token", token);
    const result = await runAws(r2Args("list-objects-v2", args));
    const page = parseJson(Buffer.from(result.stdout), "R2_144H_INVENTORY_INVALID");
    for (const item of page.Contents || []) {
      const size = Number(item.Size);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("R2_144H_INVENTORY_SIZE_INVALID");
      bucketObjectCount += 1;
      bucketTotalBytes += size;
      if (String(item.Key).startsWith(`${GFS_144H_NAMESPACE}/`)) {
        namespaceObjectCount += 1;
        namespaceTotalBytes += size;
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : null;
    if (page.IsTruncated && !token) throw new Error("R2_144H_INVENTORY_TOKEN_MISSING");
  } while (token);
  return { bucketObjectCount, bucketTotalBytes, namespaceObjectCount, namespaceTotalBytes };
}

try {
  const usage = await inventory();
  const storage = evaluateStorageProtection({ currentBytes: usage.bucketTotalBytes });
  if (storage.status !== "ALLOW") throw new Error(storage.reason);
  const latestObject = await remoteGet(LATEST_144H_KEY, "latest-144h.json");
  let publishedComplete = false;
  let latest = null;
  let latestSha256 = null;
  let manifestSha256 = null;
  let indexManifestSha256 = null;
  if (latestObject) {
    latest = latestObject.value;
    if (latest.namespace !== GFS_144H_NAMESPACE || latest.dataMode !== "OPERATIONAL_144H" || latest.coverage?.label !== "144H") {
      throw new Error("R2_144H_LATEST_INVALID");
    }
    latestSha256 = sha256(latestObject.body);
    const manifestObject = await remoteGet(latest.manifest?.key, "manifest-144h.json");
    if (!manifestObject || manifestObject.body.byteLength !== latest.manifest?.bytes
      || sha256(manifestObject.body) !== latest.manifest?.sha256 || manifestObject.value.status !== "COMPLETE"
      || manifestObject.value.runId !== latest.runId || manifestObject.value.namespace !== GFS_144H_NAMESPACE) {
      throw new Error("R2_144H_SOURCE_MANIFEST_INTEGRITY_FAILED");
    }
    manifestSha256 = sha256(manifestObject.body);
    const indexKey = indexV2ManifestKey(latest.runId);
    const indexObject = await remoteGet(indexKey, "index-144h.json");
    if (!indexObject) throw new Error("R2_144H_INDEX_MANIFEST_MISSING");
    validateIndexV2Manifest(indexObject.value, { runId: latest.runId, sourceManifest: latest.manifest });
    indexManifestSha256 = sha256(indexObject.body);
    const descriptors = [manifestObject.value.grid, ...manifestObject.value.forecasts,
      ...indexObject.value.windows.flatMap((window) => window.tiles), latest.manifest,
      { key: indexKey, bytes: indexObject.body.byteLength, sha256: indexManifestSha256 }];
    const matches = await Promise.all(descriptors.map(remoteHeadMatches));
    if (matches.some((value) => !value)) throw new Error("R2_144H_PUBLISHED_OBJECT_INTEGRITY_FAILED");
    publishedComplete = true;
  }
  const result = { status: "R2_144H_PUBLICATION_INSPECTED", publishedComplete,
    runId: latest?.runId || null, modelRunAt: latest?.modelRunAt || null, latestValidAt: latest?.latestValidAt || null,
    latestSha256, manifestSha256, indexManifestSha256, ...usage, storage };
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT,
      `published_complete=${publishedComplete}\npublished_model_run_at=${result.modelRunAt || ""}\n`
      + `published_run_id=${result.runId || ""}\nr2_object_count=${usage.bucketObjectCount}\n`
      + `r2_total_bytes=${usage.bucketTotalBytes}\nr2_144h_object_count=${usage.namespaceObjectCount}\n`
      + `r2_144h_total_bytes=${usage.namespaceTotalBytes}\nlatest_sha256=${latestSha256 || ""}\n`
      + `manifest_sha256=${manifestSha256 || ""}\nindex_manifest_sha256=${indexManifestSha256 || ""}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
