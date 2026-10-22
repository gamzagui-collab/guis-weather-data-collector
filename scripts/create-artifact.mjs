import { resolve } from "node:path";
import { createPublicationArtifact } from "../src/artifact.mjs";

const index = process.argv.indexOf("--verified-local-store");
if (index < 0 || !process.argv[index + 1]) throw new Error("GFS_LOCAL_STORE_REQUIRED");
const metadata = await createPublicationArtifact({
  storeRoot: resolve(process.argv[index + 1]),
  artifactRoot: resolve(process.env.GFS_ARTIFACT_ROOT || ".artifact"),
  provenance: {
    repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF_NAME,
    commit: process.env.GITHUB_SHA,
    workflowRunId: process.env.GITHUB_RUN_ID
  }
});
process.stdout.write(`${JSON.stringify({ status: "VERIFIED_ARTIFACT_CREATED", runId: metadata.runId, objectCount: metadata.objectCount })}\n`);
