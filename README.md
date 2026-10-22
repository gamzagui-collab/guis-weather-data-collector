# guis-weather-data-collector

This repository collects official NOAA/NCEP GFS 0.25 degree
surface APCP GRIB2, decodes it with ecCodes, verifies its time/unit/grid
contract, and publishes immutable JSON shards.

The current P2-I-E pilot is intentionally manual-only:

- `.github/workflows/collect-gfs.yml` exposes only `workflow_dispatch`;
- no `schedule`, `pull_request`, or untrusted code execution trigger exists;
- the pilot permits exactly f001, f003, f006, and f012;
- NOAA discovery plus GRIB downloads are capped at six upstream requests and
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
```

The publisher writes the grid and forecast shards, reads them back, verifies
their schema/byte length/SHA-256, writes and verifies the manifest, and changes
`latest.json` last. An incomplete run is not reachable from `latest.json`.
Each object PUT is atomic in R2; the local mock emulates pointer replacement
with a temporary file and rename.

`frameId` includes forecast hour, accumulation period, accumulation start, and
accumulation end. Therefore the official f012 PT12H and f012 PT6H records remain
distinct even though they have the same `validAt`.

## Object-store boundary

`src/publisher.mjs` depends only on this minimal object-store interface:

- `put(key, bytes, options)`
- `get(key)` / `tryGet(key)` / `head(key)`
- `list(prefix)`
- `delete(key)`

`LocalObjectStore` is the tested mock. `scripts/publish-r2.mjs` uses the R2
S3-compatible endpoint only after explicit `--execute`; it checks every local
hash, uploads immutable objects first, checks remote byte length and SHA-256
metadata, and uploads `latest.json` last. Credentials must be scoped to the
single Preview bucket. Listing/deletion can be omitted from the collection
credential and granted only to a separately reviewed retention job.

## Scheduling and recovery

The disabled template uses one concurrency group with
`cancel-in-progress: false`, so two collection jobs cannot publish the same run
concurrently. The collector compares the discovered run with `latest.json` and
returns `UNCHANGED` rather than downloading it again.

The future repository must monitor:

- last successful workflow time and `status/collector.json`;
- `latest.json.modelRunAt` and `latestValidAt` age;
- schedule delay or cancellation;
- GitHub's automatic schedule disablement after 60 days of no public-repository
  activity.

Recovery is a manual `workflow_dispatch` after checking NOAA publication and
the object-store budget. A failed collection leaves the previous latest run
unchanged and records a sanitized failure code. It must never relabel the old
run as current.

Before GRIB downloads start, the collector performs a HEAD check for the
configured final forecast-hour `.idx` file. A newly created but incomplete NOAA
run is rejected as `GFS_LATEST_RUN_NOT_COMPLETE`; the prior published run stays
visible with its original timestamps. In GitHub Actions the forecast-hour list
is mandatory and has no silent four-frame fallback.

## Safe activation checklist

1. Confirm the complete forecast-hour list and measure a full run.
2. Create a separate repository and make the reviewed branch its default.
3. Create the Preview-only R2 subscription/bucket after approval.
4. Implement and test the R2 adapter; keep `latest.json` as the final write.
5. Add bucket-scoped credentials through repository secrets (never logs).
6. Rename the workflow to `.yml`, run manually, verify hashes and rollback.
7. Only then enable the schedule.

NOAA requests remain sequential and are separated by at least 10 seconds. The
browser and Weather Worker never download GRIB2 per user request.
