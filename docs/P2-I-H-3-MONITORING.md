# P2-I-H-3 GFS schedule monitoring

The collector monitor treats scheduled and manual workflow runs as different evidence. A successful `workflow_dispatch` run cannot hide a missing or failed `schedule` run. A successful scheduled `NO_NEW_COMPLETE_RUN` is execution success, but it is not recorded as a new R2 publication.

The 2026-10-22 23:37 UTC collector slot started at 2026-10-23 01:52:34 UTC. Its 135 minute delay is retained as the `COLLECTOR_SCHEDULE_START_DELAYED` regression case. Missing execution becomes a failure after four hours; two consecutive scheduled failures also fail the monitor.

The monitor tracks its own scheduled runs separately. This detects a missed monitor slot when a later manual audit runs, but no workflow can alert while its own scheduler is entirely inactive. An independent free-tier watcher should therefore call the GitHub Actions API or inspect the public workflow status from outside this repository. A Cloudflare Cron Trigger attached to an already approved monitoring Worker or an external free uptime monitor can do this without access to NOAA, R2 credentials, or Weather secrets. Creating that external watcher remains a separately approved operation.

The active scheduled monitor run is injected as explicit evidence while its job is still in progress. GitHub reports that run as `in_progress`, so excluding it as if only completed runs existed caused the first real scheduled monitor to diagnose its own slot as missing. The injected record is accepted only when its event is `schedule`; a current manual run cannot satisfy the monitor schedule.

Manual recovery remains available through the existing `workflow_dispatch` collector and monitor workflows. GitHub Actions schedules may be disabled after prolonged repository inactivity; the recovery procedure is to confirm `main`, re-enable the workflows, run the monitor manually, and then verify the next real `event=schedule` execution.
