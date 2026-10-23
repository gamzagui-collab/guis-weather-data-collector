import { resolve } from "node:path";
import { createPublicationArtifact144 } from "../src/artifact-144.mjs";

const index = process.argv.indexOf("--verified-local-store");
if (index < 0 || !process.argv[index + 1]) throw new Error("GFS_144H_LOCAL_STORE_REQUIRED");
const metadata = await createPublicationArtifact144({
  storeRoot: resolve(process.argv[index + 1]),
  artifactRoot: resolve(process.env.GFS_ARTIFACT_ROOT || ".artifact-144h"),
  provenance: {
    repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF_NAME,
    commit: process.env.GITHUB_SHA,
    workflowRunId: process.env.GITHUB_RUN_ID
  }
});
process.stdout.write(`${JSON.stringify({ status: "VERIFIED_144H_ARTIFACT_CREATED", runId: metadata.runId,
  objectCount: metadata.objectCount })}\n`);
