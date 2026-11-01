const OPERATIONAL_WORKFLOW = ".github/workflows/collect-gfs-144h-operational.yml";

export function validatePublishSource144({ repository, run, jobs, artifacts, expectedRunId, expectedArtifactId }) {
  const runId = Number(expectedRunId);
  const artifactId = Number(expectedArtifactId);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "")
    || !Number.isSafeInteger(runId) || runId < 1
    || !Number.isSafeInteger(artifactId) || artifactId < 1) {
    throw new Error("GFS_144H_PUBLISH_SOURCE_INPUT_INVALID");
  }
  const workflowPath = String(run?.path || "").split("@")[0];
  const collectSucceeded = Array.isArray(jobs)
    && jobs.some((job) => (job.name === "collect" || job.name?.endsWith(" / collect"))
      && job.status === "completed" && job.conclusion === "success");
  if (run?.id !== runId || run?.repository?.full_name !== repository || workflowPath !== OPERATIONAL_WORKFLOW
    || run.event !== "schedule" || run.head_branch !== "main" || run.status !== "completed"
    || !["cancelled", "success"].includes(run.conclusion) || !/^[a-f0-9]{40}$/.test(run.head_sha || "")
    || !collectSucceeded) {
    throw new Error("GFS_144H_PUBLISH_SOURCE_RUN_INVALID");
  }
  const matches = (artifacts || []).filter((artifact) => artifact.id === artifactId
    && artifact.expired === false && /^gfs-144h-\d{8}T\d{6}Z$/.test(artifact.name || "")
    && artifact.workflow_run?.id === runId && artifact.workflow_run?.head_sha === run.head_sha);
  if (matches.length !== 1) throw new Error("GFS_144H_PUBLISH_SOURCE_ARTIFACT_INVALID");
  return { runId: String(runId), headSha: run.head_sha, artifactId: String(artifactId),
    artifactName: matches[0].name };
}
