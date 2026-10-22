import { createArtifactPreflight, verifyArtifactPreflight } from "../src/artifact-preflight.mjs";

const mode = process.argv[2];
const root = process.env.GFS_ARTIFACT_PREFLIGHT_ROOT || "artifact-package";
const identity = { root, runId: process.env.GITHUB_RUN_ID, commit: process.env.GITHUB_SHA };
const result = mode === "--create"
  ? await createArtifactPreflight(identity)
  : mode === "--verify"
    ? await verifyArtifactPreflight(identity)
    : (() => { throw new Error("ARTIFACT_PREFLIGHT_MODE_REQUIRED"); })();
process.stdout.write(`${JSON.stringify({ status: mode === "--create" ? "CREATED" : "VERIFIED", ...result })}\n`);
