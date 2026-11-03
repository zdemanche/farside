# E5 remaining work

Demo mode serves a generated synthetic estate for a dedicated demo org. Provider clients are not invoked. Scheduled scans, billing, iac-hub onboarding, and a live tenant stay leftover.

## Done here

| Task | Issue | What landed |
|---|---|---|
| E5-S1-T1 | #160 | `generateDemoEstate()` builds inventory, findings, cost, coverage, issues, and a succeeded scan from invented names and passes contract validation. |
| E5-S1-T2 | #161 | Org `demo` is seeded on first access, labelled `Demo`, and harvest/scan POSTs return the seed without calling injected provider clients. |
| E5-S1-T3 | #162 | Console demo mode walks every existing screen with a populated state and the Demo label. |

## Leftovers

### Live soak, iac-hub, Identity, billing

Scheduled soak (#167), customer deploy (#175), rehearsal (#176), and account retirement (#182) need a live tenant or iac-hub. Billing screen (#171) waits on stored plan state (#170).
