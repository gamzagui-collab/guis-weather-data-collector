# P2-I-J-7 operational 144H cutover

The permanent 144-hour collector and monitor are intentionally stored as
`*.yml.disabled`. GitHub does not schedule them in this state.

Activation gates:

1. A new official 144-hour model is published by an `event=schedule` run.
2. Source and index manifests are COMPLETE and their SHA-256 values verify.
3. The model is FRESH and its f001-f048 contracts pass compatibility checks.
4. The Preview Worker plan and measured CPU satisfy the account limit.
5. Preview public/mobile regressions and rollback tests pass.

Only after all gates pass may the files be renamed to `.yml`. Immediately
before that activation commit, record the actual UTC activation instant once
as the non-secret GitHub Actions repository variable
`GFS_144H_OPERATIONAL_ACTIVE_SINCE`. Do not pre-create it, reuse the Canary
start/expiry time, or update it on each monitor run. Both the collector gate
and monitor fail closed when this value is missing, malformed, in the future,
or not later than the Canary expiry. The operational
collector runs at 07:17 and 19:17 UTC, shares the NOAA concurrency group with
the existing 48-hour collector, preserves the 135-request/20MiB/10-second
limits through the reusable manual pipeline, and keeps R2 credentials out of
the collection job. The monitor runs at 11:17 and 23:17 UTC and keeps schedule,
publication, no-new-run, delay and freshness evidence separate.

The existing Canary files, dates and two-publication limit are not changed.
The existing 48-hour schedule remains active until a successful permanent
144-hour scheduled publication and Preview cutover are independently verified.

Activation order after the Canary closes is: confirm there is no queued or
running Canary; capture the current UTC instant in
`GFS_144H_OPERATIONAL_ACTIVE_SINCE`; verify the stored value; rename both
operational workflows in the same reviewed change; then preserve that value
for all later scheduled runs. A missing or invalid value is an activation
failure, not a healthy no-op.
