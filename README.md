# guis-weather-data-collector

The bounded 144H scheduled Canary and its real GitHub/R2 monitor are described
in `docs/P2-I-J-5-144H-CANARY.md`. The public Weather service continues to use
the independent 48H schedule during this Canary.

This repository collects official NOAA/NCEP GFS 0.25 degree
surface APCP GRIB2, decodes it with ecCodes, verifies its time/unit/grid
contract, and publishes immutable JSON shards.

P2-I-H-1 adds a versioned 8 x 8 grid-tile index for the 31 x 31 Korea grid.
The index is derived only from already verified forecast shards. It preserves
every accumulation contract and source-shard SHA-256 while allowing a site
query to read one tile instead of all forecast shards. Source forecast objects
and the root run manifest remain immutable.

The P2-I-H-2B pipeline keeps the recovery workflows and runs the verified
combined collect-to-publish workflow at 05:37, 11:37, 17:37 and 23:37 UTC.
The schedule was activated only after a new official run passed the complete
manual collect, Artifact, R2 publication and latest-pointer E2E.

P2-I-J-2 adds an isolated manual `144H` mode without changing that 48-hour
schedule. It requests exactly f001-f120 hourly and f123-f144 every three hours
(128 official forecast files), rejects any missing member, and publishes only
under `horizons/144h/`. The root 48-hour `latest.json` is never a target of the
144-hour publisher. Its v2 index keeps the 8 x 8 spatial tiles and divides time
into six 24-hour windows so a site query reads only the requested period.

P2-I-J-4 adds a cutover-readiness layer without activating the 144-hour
schedule. The active 48-hour and manual 144-hour collectors share one NOAA
collection concurrency group. A disabled automatic workflow template retains
the 128-file, 135-request, 20-MiB and ten-second-spacing limits. The read-only
cutover audit compares every official f001-f048 contract for one identical
`modelRunAt`, rejects cross-run comparisons, and computes a namespace-aware R2
retention dry run without issuing PutObject, DeleteObject or lifecycle changes.

Independent recovery workflows remain available:

- `.github/workflows/r2-preflight.yml` performs a private canary put/head/get/hash/delete test without NOAA access;
- `.github/workflows/collect-gfs.yml` collects and validates NOAA data, then stores a three-day GitHub Actions artifact without R2 credentials;
- `.github/workflows/publish-gfs.yml` accepts a verified artifact only when the trusted main-branch run's `collect` job succeeded, including recovery from a combined workflow whose later publish job failed; it revalidates and publishes without NOAA access;
- recovery workflows have no `schedule`, `pull_request`, or untrusted-code trigger;
- the manual collector requires every official forecast file from f001 through f048;
- run discovery and 48 GRIB downloads are capped at 55 upstream requests and
  15 MiB, with a minimum ten-second interval;
- GFS data is written only to the private Preview bucket named
  `guis-weather-gfs-preview`;
- the existing 48-hour Preview feed keeps its current policy; the new 144-hour
  feed remains non-public in this stage.

The combined workflow has two jobs. `collect` receives no R2 credentials and
uploads a three-day verified artifact. `publish` starts only after `collect`
succeeds, receives the bucket-scoped credentials, downloads the same-run
artifact, revalidates provenance and hashes, publishes the generated 8 x 8
tile index, and changes `latest.json` last. A failed publish can be recovered
from the verified artifact with the manual publisher without another NOAA
collection.

## Publication contract

The future Preview bucket is expected to contain:

```text
latest.json
status/collector.json
runs/{runId}/manifest.json
runs/{runId}/grid.json
runs/{runId}/forecasts/{frameId}.json
runs/{runId}/indexes/v1/manifest.json
runs/{runId}/indexes/v1/tiles/{tileId}.json
```

The separately published 144-hour manual validation uses:

```text
horizons/144h/latest.json
horizons/144h/status/collector.json
horizons/144h/runs/{runId}/manifest.json
horizons/144h/runs/{runId}/grid.json
horizons/144h/runs/{runId}/forecasts/{frameId}.json
horizons/144h/runs/{runId}/indexes/v2/manifest.json
horizons/144h/runs/{runId}/indexes/v2/tiles/{tileId}/{timeWindow}.json
```

`.github/workflows/collect-gfs-144h-manual.yml` is `workflow_dispatch` only,
has a 60-minute collection timeout, a 135-request/20-MiB ceiling, keeps R2
credentials out of the collector job, and publishes the namespaced latest
pointer only after source and index verification. It does not add a schedule.

The publisher writes the grid and forecast shards, reads them back, verifies
their schema/byte length/SHA-256, writes and verifies the manifest, and changes
`latest.json` last. An incomplete run is not reachable from `latest.json`.
Each object PUT is atomic in R2; the local mock emulates pointer replacement
with a temporary file and rename.

`frameId` includes forecast hour, accumulation period, accumulation start, and
accumulation end. Therefore the official f012 PT12H and f012 PT6H records remain
distinct even though they have the same `validAt`.

The tile-index manifest records the exact root-manifest SHA-256 and is written
only after every immutable tile has been uploaded and read back successfully.
An index whose source hash differs from the root run manifest is rejected. The
manual-only `backfill-gfs-index.yml` workflow can build this derived index for a
previously published run from its verified collector artifact; it does not call
NOAA and it does not update `latest.json`.

The collector artifact records its repository, branch, commit, workflow run ID,
object allowlist, byte lengths, and SHA-256 values. The publisher checks the
source GitHub workflow identity and success state before downloading it. A
publication retry reuses the same short-lived artifact and does not contact
NOAA again. Artifacts are transport for a single publish attempt, not a weather
data store.

## Object-store boundary

`src/publisher.mjs` depends only on this minimal object-store interface:

- `put(key, bytes, options)`
- `get(key)` / `tryGet(key)` / `head(key)`
- `list(prefix)`
- `delete(key)`

`LocalObjectStore` is the tested mock. `scripts/publish-r2.mjs` uses the R2
S3-compatible endpoint only after explicit `--execute`; it checks every local
hash, uploads immutable objects first, downloads every object to verify its
actual byte length and SHA-256, rejects a latest-pointer time regression, and
uploads `latest.json` last. Credentials must be scoped to the
single Preview bucket. Listing/deletion can be omitted from the collection
credential and granted only to a separately reviewed retention job.

## Scheduling and recovery

`.github/workflows/collect-gfs-automatic.yml` contains the active
05:37/11:37/17:37/23:37 UTC schedule. It uses one concurrency group with
`cancel-in-progress: false`, so two collection jobs cannot publish the same run
concurrently. `NO_NEW_COMPLETE_RUN` is returned only after the Preview R2 latest
pointer, source manifest, tile-index manifest, and referenced object metadata have
been verified. If a trusted Artifact exists but R2 publication is incomplete,
`ARTIFACT_EXISTS_UNPUBLISHED` reuses it in the publish-only job without another
NOAA download.

R2 credentials remain outside the collector job. A separate publication-state
job performs the fail-closed R2 integrity and storage check. The soft storage stop
is 8 GiB; reaching it blocks another run before NOAA download and requires an
explicit retention or capacity decision.

The future repository must monitor:

- last successful workflow time and `status/collector.json`;
- `latest.json.modelRunAt` and `latestValidAt` age;
- schedule delay or cancellation;
- GitHub's automatic schedule disablement after 60 days of no public-repository
  activity.

GitHub scheduled runs can be delayed, and schedules in public repositories may
be disabled after 60 days without repository activity. Operations must monitor
the last successful run, consecutive failures, `latest.json.modelRunAt`, and
`latestValidAt`; recovery is a manual `workflow_dispatch` after checking NOAA publication and
the object-store budget. A failed collection leaves the previous latest run
unchanged and records a sanitized failure code. It must never relabel the old
run as current.

The active combined workflow is deliberately kept manual until one complete
manual collect-to-publish run succeeds against a newer official model run.
After that checkpoint its approved schedule is 05:37, 11:37, 17:37 and 23:37
UTC. The off-hour minute reduces GitHub's documented top-of-hour scheduling
load risk. The disabled schedule monitor checks for an attempt gap over eight
hours, a success gap over fourteen hours, and two consecutive failures.

Freshness has three operational states independent from precipitation values:

- `FRESH`: a recent successful collection and model run;
- `DELAYED`: an attempt/success is over eight hours old, the model run is over
  fourteen hours old, or a recent collection failed;
- `STALE`: the forecast valid period expired, the last success is over fourteen
  hours old, or the model run is over twenty hours old.

GitHub run history and the short-lived sanitized operation artifact preserve
attempt/failure evidence even when collection fails before publishing. R2
`status/collector.json` describes the most recently verified collection and
`latest.json` remains the authoritative published pointer.

Before GRIB downloads start, the collector performs a one-byte ranged GET for the
configured final forecast-hour `.idx` file because NOMADS does not document HEAD as
an automation contract. A newly created but incomplete NOAA
run is rejected as `GFS_LATEST_RUN_NOT_COMPLETE`; the prior published run stays
visible with its original timestamps. In GitHub Actions the forecast-hour list
is mandatory and has no silent four-frame fallback.

## Safe activation checklist

1. Confirm the complete f001-f048 forecast-hour list and measure a full run.
2. Create a separate repository and make the reviewed branch its default.
3. Create the Preview-only R2 subscription/bucket after approval.
4. Implement and test the R2 adapter; keep `latest.json` as the final write.
5. Add bucket-scoped credentials through repository secrets (never logs).
6. Rename the workflow to `.yml`, run manually, verify hashes and rollback.
7. Only then enable the schedule.

NOAA requests remain sequential and are separated by at least 10 seconds. The
browser and Weather Worker never download GRIB2 per user request.
