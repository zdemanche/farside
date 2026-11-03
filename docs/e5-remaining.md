# E5 remaining work

Demo mode serves a generated synthetic estate. Recurring scans tick from Settings with time-controlled tests. The operator runbook lists sale-to-first-scan with a check and rollback on each step. Offboarding deletes org data, connections, and the schedule, and keeps a dated deletion record. A live soak week, billing screen, offboarding UI, iac-hub onboarding, and a live tenant stay leftover.

## Done here

| Task | Issue | What landed |
|---|---|---|
| E5-S1-T1 | #160 | `generateDemoEstate()` builds inventory, findings, cost, coverage, issues, and a succeeded scan from invented names and passes contract validation. |
| E5-S1-T2 | #161 | Org `demo` is seeded on first access, labelled `Demo`, and harvest/scan POSTs return the seed without calling injected provider clients. |
| E5-S1-T3 | #162 | Console demo mode walks every existing screen with a populated state and the Demo label. |
| E5-S2-T1 | #164 | `ScanScheduler` starts a system scan when the clock reaches `nextRunAt`. |
| E5-S2-T2 | #165 | Overlap is skipped and recorded, failed runs retry within a limit, and a late clock records a missed run. A broken connection does not start a scan. |
| E5-S2-T3 | #166 | Settings stores interval and retry limit; saving moves `nextRunAt`. |
| E5-S3-T2 | #170 | PUT `/v1/orgs/:orgId/contract` stores plan, start, state, and amount due. Card numbers are rejected. |
| E5-S3-T4 | #172 | Active/warning/grace allow scans. Paused, retaining, and ended return 409 and block the scheduler. |
| E5-S4-T1 | #174 | `docs/operator-runbook.md` lists contract → iac-hub → account → base → Identity → Launch → Farside → claim → connect → first scan, each with Check and Rollback. |
| E5-S5-T1 | #179 | POST `/offboard` deletes inventory, findings, cost, issues, and the rest of the org and writes a deletion record with a date. |
| E5-S5-T2 | #180 | Offboard removes connections and cancels a pending schedule. Later ticks return 410 and create nothing. |

## Leftovers

### Live soak, iac-hub, Identity, billing

Scheduled soak (#167) needs a week of unattended runs on the test subscription. Customer deploy (#175), rehearsal (#176), and account retirement (#182) need a live tenant or iac-hub. Rollback notes cover the known path; failures found only in the rehearsal stay on #177. Billing screen (#171) and the offboarding screen (#181) wait on the design-system pass (#243). Invoices are not stored — dashmeta had none to reuse. `accountClosureAt` stays null until a dedicated account is retired.
