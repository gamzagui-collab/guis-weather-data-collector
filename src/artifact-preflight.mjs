import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { sha256 } from "./contracts.mjs";

const CANARY_PATH = "payload/preflight/canary.json";
const METADATA_PATH = "metadata.json";

async function filesUnder(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, path));
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
    else throw new Error("ARTIFACT_PREFLIGHT_UNSUPPORTED_ENTRY");
  }
  return files.sort();
}

function identity({ runId, commit }) {
  if (!/^\d+$/.test(String(runId || ""))) throw new Error("ARTIFACT_PREFLIGHT_RUN_ID_INVALID");
  if (!/^[a-f0-9]{40}$/.test(String(commit || ""))) throw new Error("ARTIFACT_PREFLIGHT_COMMIT_INVALID");
  return { runId: String(runId), commit: String(commit) };
}

export async function createArtifactPreflight({ root, runId, commit }) {
  const verified = identity({ runId, commit });
  const output = resolve(root);
  const canary = Buffer.from(`${JSON.stringify({
    schemaVersion: "weather.gfs.artifact-preflight.v1",
    kind: "NON_SENSITIVE_TEST_DATA",
    ...verified
  }, null, 2)}\n`, "utf8");
  const metadata = Buffer.from(`${JSON.stringify({
    schemaVersion: "weather.gfs.artifact-preflight-metadata.v1",
    ...verified,
    files: [{ path: CANARY_PATH, bytes: canary.byteLength, sha256: sha256(canary) }]
  }, null, 2)}\n`, "utf8");
  await mkdir(join(output, "payload", "preflight"), { recursive: true });
  await writeFile(join(output, CANARY_PATH), canary);
  await writeFile(join(output, METADATA_PATH), metadata);
  return { files: [METADATA_PATH, CANARY_PATH], sha256: sha256(canary), bytes: canary.byteLength };
}

export async function verifyArtifactPreflight({ root, runId, commit }) {
  const verified = identity({ runId, commit });
  const input = resolve(root);
  const files = await filesUnder(input);
  const expectedFiles = [METADATA_PATH, CANARY_PATH].sort();
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) throw new Error("ARTIFACT_PREFLIGHT_FILE_SET_INVALID");
  const metadataBody = await readFile(join(input, METADATA_PATH));
  const canaryBody = await readFile(join(input, CANARY_PATH));
  const metadata = JSON.parse(metadataBody.toString("utf8"));
  const canary = JSON.parse(canaryBody.toString("utf8"));
  if (metadata.runId !== verified.runId || canary.runId !== verified.runId ||
      metadata.commit !== verified.commit || canary.commit !== verified.commit) {
    throw new Error("ARTIFACT_PREFLIGHT_IDENTITY_MISMATCH");
  }
  const descriptor = metadata.files?.[0];
  if (descriptor?.path !== CANARY_PATH || descriptor.bytes !== canaryBody.byteLength ||
      descriptor.sha256 !== sha256(canaryBody)) throw new Error("ARTIFACT_PREFLIGHT_INTEGRITY_FAILED");
  return { files, sha256: descriptor.sha256, bytes: descriptor.bytes };
}
