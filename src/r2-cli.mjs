import { spawn } from "node:child_process";

export const PREVIEW_BUCKET = "guis-weather-gfs-preview";

export function verifiedR2Environment(env = process.env) {
  const accountId = String(env.R2_ACCOUNT_ID || "");
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || "");
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || "");
  const bucket = String(env.R2_BUCKET || "");
  if (!/^[a-f0-9]{32}$/.test(accountId)) throw new Error("R2_ACCOUNT_ID_FORMAT_INVALID");
  if (!/^[a-f0-9]{32}$/i.test(accessKeyId)) throw new Error("R2_ACCESS_KEY_ID_FORMAT_INVALID");
  if (!/^[a-f0-9]{64}$/i.test(secretAccessKey)) throw new Error("R2_SECRET_ACCESS_KEY_FORMAT_INVALID");
  if (bucket !== PREVIEW_BUCKET) throw new Error("R2_BUCKET_NOT_ALLOWED");
  return {
    bucket,
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    childEnv: {
      ...env,
      AWS_ACCESS_KEY_ID: accessKeyId,
      AWS_SECRET_ACCESS_KEY: secretAccessKey,
      AWS_DEFAULT_REGION: "auto",
      AWS_EC2_METADATA_DISABLED: "true"
    }
  };
}

export function runAws(args, { env = process.env, allowFailure = false } = {}) {
  const config = verifiedR2Environment(env);
  return new Promise((resolve, reject) => {
    const child = spawn("aws", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: config.childEnv });
    let stdout = "", errorText = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { errorText += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      const failureKind = code === 0 ? null : /NoSuchKey|Not Found|\(404\)/i.test(errorText) ? "NOT_FOUND" : "FAILED";
      if (code === 0 || allowFailure) resolve({ code, stdout, failureKind });
      else reject(new Error(`R2_AWS_CLI_EXIT_${code}`));
    });
  });
}

export function r2Args(command, values, env = process.env) {
  const config = verifiedR2Environment(env);
  return ["s3api", command, "--endpoint-url", config.endpoint, "--bucket", config.bucket, ...values];
}
