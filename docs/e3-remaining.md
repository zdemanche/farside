# E3 remaining work

In-repo check engine, leftover waste checks, idle plan/LB/NAT checks, Recovery gaps, Lifecycle items, and an Issues list run against ground-truth fixtures. Live Azure proof of those findings stays leftover.

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
| E3-S4-T1 | #102 | Production VM/SQL backup: fail unprotected, pass protected, counted as N of M. |
| E3-S4-T2 | #103 | Zone/geo: fail `db-no-zone-geo` with the missing setting, pass `db-zone-geo`. |
| E3-S4-T3 | #104 | Missing production marker or Backup Reader evidence is `undetermined`. |
| E3-S4-T4 | #105 | Console `#recovery` lists the gaps with N of M and coverage. |
| E3-S5-T1 | #107 | In-repo retiring SKU catalogue; every entry has a source. |
| E3-S5-T2 | #108 | Retiring SKU: fail `vm-retiring-sku` with the catalogue date, pass unlisted SKUs with catalogue version. |
| E3-S5-T3 | #109 | App Service and gateway certs inside the 60-day window fail with expirationDate. |
| E3-S5-T4 | #110 | Console `#lifecycle` lists items by date and counts those in 90 days. |

## Leftovers

### Live scan to console (#95)

A recorded full scan of the test subscription into the deployed console. The fixture Issues list is not that proof.

### Metrics harvest (#89)

Monitoring Reader on the test subscription.

### Later E3 stories

Busy-gateway negative on the live test estate (#96). Live Backup Reader against vault items (#102). Live near-expiry cert proof (#106). Close-only-if-covered Issues store, Scans screens, and live accuracy (#111–#125).
