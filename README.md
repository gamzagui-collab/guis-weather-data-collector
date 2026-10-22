# guis-weather-data-collector

This repository collects official NOAA/NCEP GFS 0.25 degree
surface APCP GRIB2, decodes it with ecCodes, verifies its time/unit/grid
contract, and publishes immutable JSON shards.

P2-I-H-1 adds a versioned 8 x 8 grid-tile index for the 31 x 31 Korea grid.
The index is derived only from already verified forecast shards. It preserves
every accumulation contract and source-shard SHA-256 while allowing a site
query to read one tile instead of all forecast shards. Source forecast objects
and the root run manifest remain immutable.

The P2-I-G 48-hour validation remains intentionally manual-only and split into three
independent workflows:

- `.github/workflows/r2-preflight.yml` performs a private canary put/head/get/hash/delete test without NOAA access;
- `.github/workflows/collect-gfs.yml` collects and validates NOAA data, then stores a three-day GitHub Actions artifact without R2 credentials;
- `.github/workflows/publish-gfs.yml` accepts only a successful `collect-gfs.yml` run from this repository's `main`, revalidates its artifact, and publishes it without NOAA access;
- no `schedule`, `pull_request`, or untrusted code execution trigger exists;
- the manual collector requires every official forecast file from f001 through f048;
- run discovery and 48 GRIB downloads are capped at 55 upstream requests and
  15 MiB, with a minimum ten-second interval;
- GFS data is written only to the private Preview bucket named
  `guis-weather-gfs-preview`;
- public Weather GFS remains disabled.

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

`.github/workflows/collect-gfs.schedule.yml.disabled` contains the proposed
05:37/11:37/17:37/23:37 UTC schedule. Its non-YAML extension is a deliberate
hard stop: the schedule is not active. The disabled template uses one concurrency group with
`cancel-in-progress: false`, so two collection jobs cannot publish the same run
concurrently. The collector compares the discovered run with `latest.json` and
returns `UNCHANGED` rather than downloading it again.

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
