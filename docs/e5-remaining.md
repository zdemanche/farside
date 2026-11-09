# E5 remaining work

Demo mode serves a generated synthetic estate. Recurring scans tick from Settings with time-controlled tests. The operator runbook lists sale-to-first-scan with a check and rollback on each step. Offboarding deletes org data, connections, and the schedule, and keeps a dated deletion record. Export endpoints return issues, inventory, and cost in `farside-export/1`. Customer deploy, rehearsal, soak and account-retire tooling is built and skips cleanly without credentials. **No live soak, rehearsal, customer deploy or account retirement has run.** Billing screen, offboarding UI and export buttons wait on the design-system pass.

## Done here

| Task | Issue | What landed |
|---|---|---|
| E5-S1-T1 | #160 | `generateDemoEstate()` builds inventory, findings, cost, coverage, issues, and a succeeded scan from invented names and passes contract validation. |
| E5-S1-T2 | #161 | Org `demo` is seeded on first access, labelled `Demo`, and harvest/scan POSTs return the seed without calling injected provider clients. |
| E5-S1-T3 | #162 | Console demo mode walks every existing screen with a populated state and the Demo label. |
| E5-S2-T1 | #164 | `ScanScheduler` starts a system scan when the clock reaches `nextRunAt`. |
| E5-S2-T2 | #165 | Overlap is skipped and recorded, failed runs retry within a limit, and a late clock records a missed run. A broken connection does not start a scan. |
| E5-S2-T3 | #166 | Settings stores interval and retry limit; saving moves `nextRunAt`. |
| E5-S2-T4 (in-repo) | #167 | `scripts/soak/soak.mjs` (`npm run soak`) drives the production tick path over N cycles on a controlled clock (optional seeded failures and dropped ticks) and writes a pass/fail record of missed, failed, duplicate and overlapping runs. `--live --since` analyses one org's history from a deployed API; skips without `FARSIDE_API_URL` / `FARSIDE_ORG`. |
| E5-S3-T1 | #169 | `docs/billing.md` records D8, the dedicated-account meter, empty invoices, and what `BillingHub` is reused for. |
| E5-S3-T2 | #170 | PUT `/v1/orgs/:orgId/contract` stores plan, start, state, and amount due. Card numbers are rejected. |
| E5-S3-T4 | #172 | Active/warning/grace allow scans. Paused, retaining, and ended return 409 and block the scheduler. |
| E5-S4-T1 | #174 | `docs/operator-runbook.md` lists contract → iac-hub → account → base → Identity → Launch → Farside → claim → connect → first scan, each with Check and Rollback. |
| E5-S4-T2 (in-repo) | #175 | `infra/customers.json` + `infra/src/customer-cli.ts` build `Pulumi.<customer>.yaml` (key, account id, `farside.<customer>.moonaan.com`). `deploy-customer.yml` previews or applies one customer without iac-hub and skips without AWS / Pulumi credentials. |
| E5-S4-T3 (in-repo) | #176 | `scripts/operator-runbook/rehearse.mjs` walks the ten steps, checks preconditions, writes `docs/rehearsals/<date>-<customer>-<mode>.json`. `--live` calls contract, connect, first scan; skips without `FARSIDE_API_URL` / `FARSIDE_OPERATOR_TOKEN`; never performs iac-hub, base, Identity, Launch or claim. |
| E5-S4-T4 | #177 | Operator runbook appendix walks an injected `clientSecret` on connect: 400, nothing stored, clean retry. |
| E5-S5-T1 | #179 | POST `/offboard` deletes inventory, findings, cost, issues, and the rest of the org and writes a deletion record with a date. |
| E5-S5-T2 | #180 | Offboard removes connections and cancels a pending schedule. Later ticks return 410 and create nothing. |
| E5-S5-T4 (in-repo) | #182 | `scripts/offboarding/retire-account.mjs` calls Organizations `CloseAccount` only with `--apply`, `--confirm <id>`, a registry match and a deletion receipt for the org. Dry run by default; no credentials is a skip. Runbook appendix. |
| E5-S6-T1 | #184 | GET `/export/issues`, `/export/inventory`, and `/export/cost` return `farside-export/1` rows. |
| E5-S6-T3 | #186 | Cross-org export is 403. Payload keys are rejected by the export schema. |

## Leftovers (live run or human event only)

| Item | Issue | What remains |
|---|---|---|
| Soak week | #167 | A week of unattended 15-minute ticks on the test subscription, then `npm run soak -- --live --since <start>` and the record filed. |
| Customer deploy | #175, #173 | A dedicated account and credentials; first `deploy-customer` dispatch. iac-hub registration (#26) after the org transfer. |
| Cold rehearsal | #176 | A live rehearsal record from a test tenant, with base / Identity / Launch / claim done by people. Failures found go in the runbook appendix. |
| Account retirement | #182 | The first real offboarding, run from the Organizations management account. `accountClosureAt` in the store stays null; the retirement record carries the date. |
| Billing screen, offboarding screen, export buttons | #171, #181, #185 | Design-system pass (#243). |
| Invoices | — | Not stored; dashmeta had none to reuse. |
