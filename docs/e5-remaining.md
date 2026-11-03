# E5 remaining work

Demo mode serves a generated synthetic estate. Recurring scans tick from Settings with time-controlled tests. A live soak week, billing, iac-hub onboarding, and a live tenant stay leftover.

## Done here

| Task | Issue | What landed |
|---|---|---|
| E5-S1-T1 | #160 | `generateDemoEstate()` builds inventory, findings, cost, coverage, issues, and a succeeded scan from invented names and passes contract validation. |
| E5-S1-T2 | #161 | Org `demo` is seeded on first access, labelled `Demo`, and harvest/scan POSTs return the seed without calling injected provider clients. |
| E5-S1-T3 | #162 | Console demo mode walks every existing screen with a populated state and the Demo label. |
| E5-S2-T1 | #164 | `ScanScheduler` starts a system scan when the clock reaches `nextRunAt`. |
| E5-S2-T2 | #165 | Overlap is skipped and recorded, failed runs retry within a limit, and a late clock records a missed run. A broken connection does not start a scan. |
| E5-S2-T3 | #166 | Settings stores interval and retry limit; saving moves `nextRunAt`. |

## Leftovers

### Live soak, iac-hub, Identity, billing

Scheduled soak (#167) needs a week of unattended runs on the test subscription. Customer deploy (#175), rehearsal (#176), and account retirement (#182) need a live tenant or iac-hub. Billing screen (#171) waits on stored plan state (#170).
