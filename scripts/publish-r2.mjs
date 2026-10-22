import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LocalObjectStore } from "../src/object-store.mjs";
import { parseJson, sha256 } from "../src/contracts.mjs";
import { LATEST_KEY, STATUS_KEY, readLatestPublication } from "../src/publisher.mjs";

if (!process.argv.includes("--execute")) throw new Error("R2_REMOTE_EXECUTION_FLAG_REQUIRED");
const index = process.argv.indexOf("--verified-local-store");
if (index < 0 || !process.argv[index + 1]) throw new Error("R2_LOCAL_STORE_REQUIRED");
const localRoot = resolve(process.argv[index + 1]);
const accountId = process.env.R2_ACCOUNT_ID;
const bucket = process.env.R2_BUCKET;
if (!/^[a-f0-9]{32}$/.test(accountId || "") || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket || "")) {
  throw new Error("R2_TARGET_CONFIGURATION_INVALID");
}
if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) throw new Error("R2_CREDENTIALS_MISSING");
const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
const store = new LocalObjectStore(localRoot);
const { latest, manifest } = await readLatestPublication(store);

const descriptors = [manifest.grid, ...manifest.forecasts, latest.manifest];
for (const descriptor of descriptors) {
  const body = await store.get(descriptor.key);
  if (body.byteLength !== descriptor.bytes || sha256(body) !== descriptor.sha256) throw new Error("R2_LOCAL_INTEGRITY_FAILED");
}
const status = await store.tryGet(STATUS_KEY);
const ordered = [...descriptors.map((item) => item.key), ...(status ? [STATUS_KEY] : []), LATEST_KEY];

function aws(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("aws", args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AWS_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
        AWS_DEFAULT_REGION: "auto",
        AWS_EC2_METADATA_DISABLED: "true"
      }
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => code === 0 ? resolvePromise(stdout) : rejectPromise(new Error(`R2_AWS_CLI_EXIT_${code}:${stderr.slice(0, 240)}`)));
  });
}

for (const key of ordered) {
  const localPath = store.path(key);
  const body = await readFile(localPath);
  const digest = sha256(body);
  await aws(["s3api", "put-object", "--endpoint-url", endpoint, "--bucket", bucket, "--key", key,
    "--body", localPath, "--content-type", "application/json", "--metadata", `sha256=${digest}`]);
  const remote = parseJson(Buffer.from(await aws(["s3api", "head-object", "--endpoint-url", endpoint, "--bucket", bucket, "--key", key])));
  if (Number(remote.ContentLength) !== body.byteLength || remote.Metadata?.sha256 !== digest) throw new Error("R2_REMOTE_INTEGRITY_FAILED");
}

process.stdout.write(`${JSON.stringify({ status: "PUBLISHED", runId: latest.runId, objectCount: ordered.length })}\n`);
