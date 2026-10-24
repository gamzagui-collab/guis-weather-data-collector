# P2-I-J-4 GFS 144H cutover readiness

The current 48H workflow remains active. The prepared 144H automatic workflow
is stored as `collect-gfs-144h-automatic.yml.disabled`, so GitHub cannot execute
its schedule. Enabling it, observing one successful scheduled publication, and
disabling the 48H schedule are three separate approved operations.

## Single-collection contract

One verified 144H dataset can supply the current 48H product only by selecting
the unmodified official f001-f048 contracts. Raw values, quantitative values,
missing status, accumulation start/end/period, source unit, valid time, source
hash and official grid point are not recalculated. The compatibility check
requires the same `modelRunAt` and fails closed on any contract, provenance,
grid or value mismatch. An older 48H run may remain available for recovery, but
its timestamps and STALE state must remain visible.

## Cutover order

1. Keep the 48H collector and public adapter active.
2. Enable the 144H automatic workflow only after separate approval.
3. Verify one newly scheduled 144H COMPLETE publication and its monitor state.
4. Compare that run's f001-f048 contracts with the independently collected
   same-run 48H product.
5. Validate the compatibility API, freshness guard and Preview UI.
6. Disable the 48H schedule only after a separate cutover approval.
7. Keep the last verified 48H run as a timestamp-honest recovery source.

All collection workflows use `guis-weather-gfs-noaa-collection` with
`cancel-in-progress: false`; publishers retain the independent shared
`guis-weather-gfs-r2-publisher` lock. This bounds any overlap window to an
approved transition rather than allowing simultaneous NOAA downloads.

## Independent monitoring

48H and 144H states are keyed by horizon and never share schedule evidence.
Each state records scheduled attempt/success, last publication, model run,
latest valid time, coverage, failure code, consecutive failures, schedule delay
and storage usage. `NO_NEW_COMPLETE_RUN` is a successful check but not a new
publication. The prepared 144H monitor remains disabled until the 144H schedule
is activated.

## Retention dry run

The read-only audit groups objects by the root 48H and `horizons/144h`
namespaces and by run manifest. It protects each latest-pointer target, keeps
two COMPLETE 48H runs and three COMPLETE 144H runs, and reports older COMPLETE
runs only as candidates. Unknown or unverified runs require manual review.
Latest targets, referenced manifests, forecast shards and index tiles can never
be candidates. The audit performs no delete and creates no lifecycle rule.

The 8 GiB soft stop remains authoritative. Before automatic retention is ever
enabled, a separate approval must review the exact run-level candidate list,
object count, bytes and recovery consequences.

## Failure recovery

- NOAA or schedule delay: keep the prior pointer and report DELAYED/STALE.
- Collector/Artifact failure: do not start publication.
- R2 publication/index failure: do not change latest; use publish-only recovery
  from the verified short-lived Artifact.
- Damaged latest pointer or compatibility mismatch: fail closed and keep the
  independent 48H public path.
- 8 GiB soft stop: block collection before NOAA downloads and request an
  explicit retention/capacity decision.
