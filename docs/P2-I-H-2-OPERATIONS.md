# P2-I-H-2 GFS automatic collection operations

## Run and publication states

- `NEW_RUN`: the newest complete official f048 run has no trusted Artifact and is collected once.
- `ARTIFACT_EXISTS_UNPUBLISHED`: a trusted Artifact exists while verified R2 publication is behind or incomplete; publish reuses it with zero NOAA redownloads.
- `PUBLISHED_COMPLETE`: R2 latest, source manifest, v1 index manifest, and referenced object descriptors agree.
- `NO_NEW_COMPLETE_RUN`: the newest complete official run is not newer than verified R2; this is a successful no-op.
- Collection and publication failures remain separate workflow failures.

Artifact existence alone never proves publication. R2 credentials are supplied
only to publication-state and publisher jobs, never to the NOAA collector job.

## Storage protection

The publication-state preflight inventories the private Preview bucket. The next
indexed run is conservatively estimated at 20 MiB. Collection is blocked before
the projected bucket total reaches the 8 GiB soft stop. No run is automatically
deleted; retention remains separately approved.

## Concurrency

Collector workflows share `guis-weather-gfs-collector-48h`. Automatic and manual
publishers additionally share `guis-weather-gfs-r2-publisher`, preventing concurrent
`latest.json` transitions. The publisher also rejects regression to an older run.

## Scope and hard limits

- Product: NOAA/NCEP GFS 0.25 degree surface APCP.
- Coverage: Republic of Korea grid, f001 through f048 only.
- Maximum per attempt: 55 NOAA HTTP requests and 15 MiB received.
- Requests are sequential with at least ten seconds between requests.
- One concurrency group serializes manual and automatic collection/publish.
- The collect job has no R2 credentials. Only publication-state and publish jobs
  receive the existing bucket-scoped Preview credentials.
- Weather GFS public access remains disabled.

## Schedule gate

The combined workflow must pass one manual `workflow_dispatch` run before the
schedule is added. The approved UTC schedule is:

- 05:37 for the 00 UTC model run;
- 11:37 for the 06 UTC model run;
- 17:37 for the 12 UTC model run;
- 23:37 for the 18 UTC model run.

The collector never assumes the target run is complete. Before GRIB downloads
it verifies that the official f048 index exists. An incomplete run produces
`GFS_NO_COMPLETE_48H_RUN_WITHIN_BUDGET` and leaves R2 unchanged.

## Atomic publication

1. Collect and decode all f001-f048 files.
2. Validate forecast-hour coverage and every accumulation contract.
3. Generate immutable forecast shards and the 8 x 8 tile index.
4. Upload a three-day GitHub artifact.
5. Download it in the publish job and revalidate repository, main ref, commit,
   workflow run ID, file allowlist, byte lengths and SHA-256 values.
6. Upload immutable objects and verify each remote body.
7. Verify the COMPLETE source and index manifests.
8. Replace `latest.json` last. A time regression is rejected.

An existing verified artifact for the same model run blocks another NOAA
download. If publication fails after collection, run `Publish Verified GFS
Artifact` with the failed combined run ID. The publisher accepts the artifact
only when that run's `collect` job succeeded.

## Status and freshness

Every collection attempt stores sanitized `collection-evidence.json` and
`operation-status.json` as a seven-day Actions artifact. No credential or
authenticated URL is included.

Operational thresholds:

- delayed attempt: more than 8 hours since the last attempt;
- delayed success: more than 8 hours since the last success;
- stale success: more than 14 hours since the last success;
- delayed model: more than 14 hours since `modelRunAt`;
- stale model: more than 20 hours since `modelRunAt`;
- expired: current time is after `latestValidAt`.

These states do not alter, interpolate or replace forecast values.

## Failure classes

- NOAA source not published: `GFS_NO_COMPLETE_48H_RUN_WITHIN_BUDGET`;
- NOAA access/rate error: `GFS_HTTP_*` or `GFS_INDEX_HTTP_*`;
- request/download budget: `GFS_REQUEST_BUDGET_EXCEEDED` or
  `GFS_BYTE_BUDGET_EXCEEDED`;
- malformed GRIB2: `GFS_GRIB_ENVELOPE_INVALID` or decoder error;
- incomplete forecast coverage: decoder/coverage validation error;
- duplicate model run: `GFS_RUN_ALREADY_COLLECTED`;
- artifact/provenance error: `GFS_ARTIFACT_*`;
- R2 authentication/upload/integrity error: `R2_*`;
- index integrity error: index manifest/source hash failure;
- schedule gap: `GFS_SCHEDULE_ATTEMPT_MISSING`;
- repeated failure: `GFS_CONSECUTIVE_FAILURES`.

Collection failure prevents the publish job. Publication failure leaves the
previous `latest.json` unchanged.

## Monitoring and recovery

The schedule monitor template runs between collection windows and inspects the
GitHub Actions run history. When enabled, a failed monitor run uses GitHub's
normal Actions failure notification path. Operators can also inspect the
workflow badge/run history and the sanitized job summary.

GitHub may delay scheduled work, drop heavily delayed work, or disable public
repository schedules after 60 days without repository activity. A monitor in
the same repository cannot detect total platform schedule disablement. An
independent external check of the GitHub Actions REST run timestamp or the
future read-only Weather freshness endpoint is therefore still required; its
deployment needs separate approval.

Recovery:

1. Confirm the repository and workflow are still enabled and the actor account
   is active.
2. Inspect the latest operation artifact and failure code.
3. If `collect` succeeded, rerun the manual publish-only workflow with that run
   ID. Do not collect NOAA again.
4. If collection failed, verify NOAA f048 availability and budgets, then use
   the combined workflow's manual dispatch.
5. If GitHub disabled the schedule, make a reviewed cron edit or enable the
   workflow, then run one manual dispatch before relying on the schedule.

## Storage estimate and retention boundary

The verified 48-hour source artifact contained 94 JSON objects and 7,066,995
uncompressed bytes. Its 16 tiles plus index manifest add 17 objects and
11,326,279 bytes. A full indexed run is therefore approximately 18.4 MB and
111 uploaded objects including the mutable status/latest objects.

At four successful runs per day without deletion:

- approximately 73.6 MB/day and 2.2 GB per 30 days;
- approximately 13,320 Class A PUT operations/month;
- approximately 26,640 publisher HEAD/GET verification operations/month,
  excluding Weather reads.

This is below the current R2 Standard free allowances of 10 GB-month storage,
1 million Class A operations and 10 million Class B operations per month for
the initial month. With no deletion, cumulative storage can exceed 10 GB after
roughly 4.5 months. Automatic deletion is intentionally not enabled. Retaining
only the latest and one previous successful run requires a separate approval
and a reviewed deletion credential/path.
