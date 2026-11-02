# E3 remaining work

In-repo check engine, leftover waste checks, idle plan/LB/NAT checks, and an Issues list run against ground-truth fixtures. Live Azure proof of those findings stays leftover.

## Done here

| Task | Issue | What landed |
|---|---|---|
| E3-S1-T1 | #85 | Check runner over stored inventory and facts. No provider calls. |
| E3-S1-T2 | #86 | Missing evidence and missing closer are rejected. |
| E3-S1-T3 | #87 | Shared `savingsRange` helper; point values rejected. |
| E3-S1-T4 | #88 | Registry tied to the spec; unregistered ids cannot run. |
| E3-S1-T6 | #90 | Unattached disk: fail `disk-unattached`, pass `disk-attached`. |
| E3-S2-T1 | #92 | Old snapshots older than Settings `snapshotRetentionDays`. |
| E3-S2-T2 | #93 | Unassociated public IPs (`associatedTo` null or empty). |
| E3-S2-T3 | #94 | Stopped-but-allocated VMs; deallocated and running pass. |
| E3-S2 Issues list | #91 | Console `#issues` lists the four fail findings with evidence and a savings range. |
| E3-S3-T1 | #97 | Empty App Service plan: fail `plan-empty`, pass `plan-with-site`. |
| E3-S3-T2 | #98 | Idle load balancer: fail `lb-idle` with metricWindow, pass `lb-busy`. |
| E3-S3-T3 | #99 | Idle NAT gateway: fail `nat-idle` with metricWindow, pass `nat-attached`. |
| E3-S3-T4 | #100 | Missing traffic metrics return `undetermined` with a Monitoring Reader closer. |

## Leftovers

### Live scan to console (#95)

A recorded full scan of the test subscription into the deployed console. The fixture Issues list is not that proof.

### Metrics harvest (#89)

Monitoring Reader on the test subscription.

### Later E3 stories

Busy-gateway negative on the live test estate (#96). Recovery, Lifecycle, close-only-if-covered Issues store, Scans screens, and live accuracy (#101–#125).
