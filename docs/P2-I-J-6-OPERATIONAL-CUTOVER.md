# P2-I-J-6 GFS 144H operational cutover preparation

This change does not activate 144H public access, change either schedule, alter
the Canary limits, download NOAA data, or delete R2 objects. The current 48H
schedule and public API remain the recovery source while the 144H Canary runs.

## Compatibility and source switch

The Weather API may enter `SHADOW_144H` only after a reviewed deployment. It
reads the official 144H `h001-h024` and `h025-h048` windows and compares their
unmodified f001-f048 contracts with the independently collected same-run 48H
contracts. Different model runs are not comparable. No subtraction, averaging,
interpolation, missing-to-zero conversion, or time conversion is allowed.

The later cutover mode is `OPERATIONAL_144H_WITH_48H_ROLLBACK`. It serves the
144H f001-f048 selection only when the 144H source is COMPLETE and FRESH. A
failure uses the independent 48H source only when the explicit rollback switch
is enabled; its original `modelRunAt`, freshness, and STALE state are retained.

## Approval-gated sequence

1. Observe at least one real scheduled Canary publication.
2. Confirm COMPLETE/FRESH 144H coverage and storage allowance.
3. Confirm same-run official 48H/144H contract compatibility.
4. Enable the prepared 144H operational schedule.
5. Observe a new scheduled COMPLETE 144H publication.
6. Enable shadow reads and verify the compatibility API.
7. Switch the 48H API source to the official 144H f001-f048 selection.
8. Verify Preview freshness guards and mobile UI.
9. Disable the legacy 48H schedule only under a separate approval.

Rollback sets the API source back to `OPERATIONAL_48H_ONLY`, keeps or restores
the 48H schedule, disables 144H public access, preserves failed-run evidence,
and verifies that old data is never relabelled as current.

## Retention dry run

The operational dry run extends the existing namespace-safe policy. It protects
both latest targets, two COMPLETE 48H runs, three COMPLETE 144H runs, the named
48H rollback source, and all Canary publication evidence. Only complete runs
outside those protections may be candidates. It emits no delete command,
performs no `DeleteObject`, and creates no lifecycle policy. The 8 GiB soft stop
continues to block collection before upstream access.
