# E3 remaining work

In-repo check engine, leftover waste checks, idle plan/LB/NAT checks, Recovery gaps, Lifecycle items, and an Issues store that closes only when covered. Live Azure proof of those findings stays leftover.

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
| E3-S6-T1 | #112 | Issue identity is check + resource + scope; repeat scans update the same issue. |
| E3-S6-T2 | #113 | Close only if covered; uncovered later scans stay `not_confirmed`. |
| E3-S6-T3 | #114 | Issues queue filters by check, status and subscription, with detail and coverage. |
| E3-S6-T4 | #115 | Replay of fixed, unfixed and uncovered scans. |
| E3-S6-T5 | #116 | Estate overview shows `scoreHealth` over assessed scopes only. |
| E3-S7-T1 | #118 | Scan history API returns duration, coverage summary, per-check outcomes, and `current` on the latest complete success. |
| E3-S7-T2 | #119 | Console `#scans` lists start, duration, status and coverage; detail shows assessed / unassessed / `undetermined` with reasons. |
| E3-S7-T3 | #120 | A running fixture scan updates to succeeded without a page reload. Failed scans show the error and are never current. |
| E3-S1-T5 | #89 | Injected metrics client returns ByteCount totals for load balancers and NAT gateways. Missing Monitoring Reader is unassessed. Live Monitor on the test subscription leftover. |

## Leftovers

### Live scan to console (#91, #95)

Built: with `FARSIDE_AZURE_LIVE=1` the scan writes live findings to the same store the console reads. Left: a recorded full scan of the test subscription into the deployed console. The fixture Issues list is not that proof.

### Live metrics harvest

Built: the live harvest reads ByteCount per LB/NAT; no data or no Monitoring Reader stays `undetermined`. Left: a Monitoring Reader series on the test subscription.

### Later E3 stories

Busy-gateway negative on the live test estate (#96). Live Backup Reader against vault items (#102). Live near-expiry cert proof (#106). The fixture Scans screen is not a live run.

### Live accuracy (#121–#125)

Built: `npm run azure-live:checks` runs every non-cost check through the production scan path and writes `docs/azure/live-runs/<date>-checks-noncost.json` with a pass/fail diff against `ground-truth.json` (#122, #123) and defects (#124). `npm run azure-live:matrix` rewrites the spec and support matrix from those records (#125). On the fake estate the diff found one defect, fixed here: a one-subscription scan dropped other subscriptions' budget findings. Known gap it will flag: gateway cert expiry is not in ARM. Left: the run on the test subscription.
