function instant(value, code) {
  const parsed = Date.parse(value || "");
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}

export function classifyDiscoveredRun({
  discoveredModelRunAt,
  publishedModelRunAt = null,
  publishedComplete = false,
  artifact = null
}) {
  const discovered = instant(discoveredModelRunAt, "GFS_DISCOVERED_RUN_TIME_INVALID");
  const published = publishedModelRunAt ? instant(publishedModelRunAt, "GFS_PUBLISHED_RUN_TIME_INVALID") : null;
  if (publishedComplete && published !== null && discovered <= published) {
    return {
      runState: "NO_NEW_COMPLETE_RUN",
      publicationState: "PUBLISHED_COMPLETE",
      action: "NOOP"
    };
  }
  if (artifact) {
    if (Date.parse(artifact.modelRunAt || discoveredModelRunAt) !== discovered
      || !/^\d+$/.test(String(artifact.workflowRunId || ""))
      || !/^[a-f0-9]{40}$/.test(String(artifact.commit || ""))
      || !/^gfs-48h-\d{8}T\d{6}Z$/.test(String(artifact.name || ""))) {
      throw new Error("GFS_EXISTING_ARTIFACT_IDENTITY_INVALID");
    }
    return {
      runState: "ARTIFACT_EXISTS_UNPUBLISHED",
      publicationState: publishedComplete ? "PUBLICATION_INCOMPLETE" : "PUBLICATION_UNVERIFIED",
      action: "PUBLISH_EXISTING"
    };
  }
  return {
    runState: "NEW_RUN",
    publicationState: "NOT_PUBLISHED",
    action: "COLLECT"
  };
}

