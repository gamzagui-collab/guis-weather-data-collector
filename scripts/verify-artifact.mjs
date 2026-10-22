import { resolve } from "node:path";
import { verifyPublicationArtifact } from "../src/artifact.mjs";

const result = await verifyPublicationArtifact({
  artifactRoot: resolve(process.env.GFS_ARTIFACT_ROOT || ".artifact"),
  expected: {
    repository: process.env.GFS_EXPECTED_REPOSITORY,
    ref: process.env.GFS_EXPECTED_REF,
    commit: process.env.GFS_EXPECTED_SHA,
    workflowRunId: process.env.GFS_EXPECTED_RUN_ID
  }
});
process.stdout.write(`${JSON.stringify({ status: "VERIFIED_ARTIFACT", runId: result.latest.runId, objectCount: result.metadata.objectCount })}\n`);
