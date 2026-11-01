import { appendFile } from "node:fs/promises";
import { validatePublishSource144 } from "../src/publish-source-144.mjs";

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const expectedRunId = process.env.GFS_SOURCE_RUN_ID;
const expectedArtifactId = process.env.GFS_SOURCE_ARTIFACT_ID;
if (!token) throw new Error("GFS_144H_PUBLISH_SOURCE_TOKEN_MISSING");
const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28" };
async function github(path) {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, { headers, redirect: "manual" });
  if (response.status !== 200) throw new Error(`GFS_144H_PUBLISH_SOURCE_GITHUB_HTTP_${response.status}`);
  return response.json();
}
const [run, jobs, artifacts] = await Promise.all([
  github(`/actions/runs/${expectedRunId}`),
  github(`/actions/runs/${expectedRunId}/jobs?per_page=100`),
  github(`/actions/runs/${expectedRunId}/artifacts?per_page=100`)
]);
const result = validatePublishSource144({ repository, run, jobs: jobs.jobs, artifacts: artifacts.artifacts,
  expectedRunId, expectedArtifactId });
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT,
    `source_run_id=${result.runId}\nsource_head_sha=${result.headSha}\nartifact_id=${result.artifactId}\nartifact_name=${result.artifactName}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify({ status: "GFS_144H_PUBLISH_SOURCE_VERIFIED", ...result })}\n`);
