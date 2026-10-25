# GFS 144H Canary operations

This Canary is limited to the Preview data collector and the existing
`guis-weather-gfs-preview` bucket. It does not change Weather Production or the
48H public adapter.

## Fixed safety contract

- Window: `2026-10-25T06:45:00Z` through `2026-10-27T06:45:00Z` (end exclusive)
- Successful new 144H publications: at most 2
- Per-run NOAA ceiling: 135 HTTP requests and 20 MiB
- NOMADS delay: at least 10 seconds between download requests
- 144H schedule: `07:17` and `19:17` UTC
- 144H monitor schedule: `11:17` and `23:17` UTC
- 48H schedule remains `05:37`, `11:37`, `17:37`, `23:37` UTC

Expiry and publication count are evaluated before the first NOAA directory
request. The publication count is reconstructed from COMPLETE 144H manifests
and the Canary status record. Reaching either limit returns a normal no-op.

## Collision and recovery behavior

Every NOAA collector uses the shared `guis-weather-gfs-noaa-collection`
concurrency group with `cancel-in-progress: false` and `queue: max`. The 144H
slots are also staggered from the 48H slots. Publication jobs use the shared
`guis-weather-gfs-r2-publisher` group and reject latest-pointer regression.

An existing trusted `gfs-144h-{runId}` Artifact is a distinct
`ARTIFACT_EXISTS_UNPUBLISHED` state. It is verified and sent through the
publish-only job without another NOAA collection.

## Evidence and monitoring

Each attempt stores sanitized collection evidence as a short-retention GitHub
Artifact. `horizons/144h/status/canary.json` records scheduled/manual event
type, outcome, per-attempt NOAA calls and bytes, cumulative calls and bytes,
and successful publication identifiers. It contains no credentials or NOAA
authentication material.

The monitor reads both GitHub workflow runs and actual R2 publication state.
It separates scheduled and manual executions, schedule delay/missing state,
collection outcome, publication state, R2 COMPLETE state, model time, storage,
and Canary aggregate usage.

GitHub-hosted schedules and their monitor can both stop when a repository is
inactive, so GitHub Actions alone is not a truly independent heartbeat. A free
external read-only heartbeat is a follow-up option; none is activated by this
Canary.

## Stop and rollback

The workflow becomes a pre-upstream no-op automatically at expiry or after two
new publications. Emergency rollback is limited to disabling the 144H Canary
workflow file; the 48H schedule and existing R2 runs stay intact. No automatic
R2 deletion or lifecycle rule is part of this phase.
