# Backlog triage

Re-triage 2026-11-02 after owner direction: D1–D8 adopted (`docs/decisions.md`); dedicated AWS account and iac-hub registration are **switch-on-later**, not blockers; missing those integrations must not fail CI; sign-off-only steps are satisfied; live Azure/GCP and unread external repos still cannot be faked — build against fixtures/mocks and note leftover verification.

The per-item table below #9 is the earlier snapshot with class notes updated for E1. Later epics keep their (c)/(d) meaning: (c) still needs a live tenant, (d) still needs a repo this workspace can read. Former (b) rows that were D1–D8 are adopted.

## Classes

| Class | Meaning now |
|---|---|
| (a) | Doable in this repo against code, tests, docs, fixtures, or mocks. |
| (b) | Was a numbered decision or agreement-only sign-off. **Adopted.** Remaining (b) is only a live event a person must attend (prospect session, named buyer). |
| (c) | Physically needs live Azure, GCP, or a Moonaan Identity test tenant. Build the code on fixtures first; do not claim a live run. |
| (d) | Needs an external repo or system. If it cannot be read, write the Farside-local shape, say there was no access, and do not invent that system's details. iac-hub / dedicated AWS are switch-on-later, not (d) blockers. |

## This batch (dependency order)

1. **E1-S1** (#10) + **E1-S6** (#36) + D1–D8 — merged.
2. **E1-S2** (#16) — merged (`@farside/scan-contracts` 0.1.0).
3. **E1-S4** (#27) — this change: reuse review of reachable Moonaan repos; no client names copied.
4. **E1-S5** (#31) — this change: seed plan + ground-truth **fixtures**; live subscription provision stays (c).
5. **E2 in-repo (org/connect/inventory)** — merged (#226).
6. **E2-S4** — merged (#232).
7. **E2-S5** — merged (#233).
8. **E2-S6** — merged (#234).
9. **E3-S1** — merged (#235).
10. **E3-S2** — merged (#236).
11. **E3-S3** — merged (#237).
12. **E3-S4** — merged (#238).
13. **E3-S5** — merged (#239).
14. **E3-S6** — merged (#240).
15. **E3-S7** — merged (#241).
16. **E4-S1** — merged (#242).
17. **E4-S2** — merged (#244).
18. **E4-S3** — merged (#245).
19. **E4-S4** — merged (#246).
20. **E4-S5** — merged (#247). Console page waits on #243.
21. **E4-S6** — merged (#248). Estate render waits on #243.
22. **E5-S1** — merged (#249).
23. **E5-S2** — merged (#250). Soak week is (c) #167.
24. **E5-S3** — this change: contract store and scan gate. Billing screen waits on #243.
25. **E3+ remaining** — live Azure accuracy (#121–#125). Portal cost match is #131. Live commitments harvest is #133. Live budget harvest is #137.

Do **not** claim a live Azure result, a reachable `/health` in a dedicated account, or an iac-hub `PRODUCTS` merge that has not happened.

## Decisions

Recorded in `docs/decisions.md`. Physical leftovers stay on the story that needs the tenant or the named prospect.

| Key | Issue | Title | Class now | Leftover |
|---|---|---|---|---|
| `D1` | #1 | Who builds Azure and GCP infrastructure | adopted | T5 Jira moves in dashmeta/AIF (#15) |
| `D2` | #2 | Separate product or inside dashmeta | adopted | Org transfer to `Moonaan/moonaan-farside` |
| `D3` | #3 | Fund an Azure test subscription | adopted as a decision | Physical subscriptions (E1-S5) |
| `D4` | #4 | Name the first buyer | adopted as an approach | Sales names the prospect (E2-S7) |
| `D5` | #5 | Trademark search for the Farside name | adopted | Formal counsel search; working clone name |
| `D6` | #6 | Go or no-go | adopted: go for in-repo work | Live Azure data still needs the D3 estate |
| `D7` | #7 | Fund a GCP test project | adopted as a decision | Physical project (E6-S1) |
| `D8` | #8 | Billing approach and suspension rule | adopted (7/14/30-day ladder) | Billing UI read 2026-11-02; implement in E5-S3 |

## E1: Cleared to build and provable on a real Azure estate (#9)

In-repo Phase 0 (boundary, spec, CI) can finish. Live proof still needs the Azure estate.

| Key | Issue | Title | Class | Why |
|---|---|---|---|---|
| `E1` | #9 | Cleared to build and provable on a real Azure estate | (c) live leftover | Docs/spec/CI in-repo; live estate is E1-S5/S7. |
| `E1-S1` | #10 | Boundary with dashmeta and Atlas agreed in writing | (d) T5 leftover | T1–T4 in this change. T5 still amends dashmeta/AIF Jira. |
| `E1-S1-T1` | #11 | Write the ownership table and attacker test | (a) this change | `docs/boundary.md`. |
| `E1-S1-T2` | #12 | List overlaps with DAS-775 and DAS-776 | (a) this change | Live Jira titles; Ryan reading satisfied by owner direction. |
| `E1-S1-T3` | #13 | Record the Jira review and handoff proposal | (a) this change | Lists match the proposal. |
| `E1-S1-T4` | #14 | Get sign-off and close decision D1 | adopted | Owner direction. |
| `E1-S1-T5` | #15 | After sign-off, amend dashmeta and move AIF tickets | (d) external Jira | Do not fake ticket moves. |
| `E1-S2` | #16 | Shared scan contracts settled with dashmeta | (a) fixtures | Build Farside-local contracts if dashmeta sources are unread; Ryan sign-off adopted. |
| `E1-S2-T1` | #17 | List gaps between dashmeta contracts and Azure/GCP needs | (d) if unread | Read dashmeta formats when the repo opens; otherwise list gaps from the proposal. |
| `E1-S2-T2` | #18 | Propose and agree contract additions | adopted | Owner direction on agreement-only steps. |
| `E1-S2-T3` | #19 | Build contract validators and fixtures | (a) | Next code PR. |
| `E1-S2-T4` | #20 | Publish the contracts as a versioned package | (a) | After T3. |
| `E1-S2-T5` | #21 | Define the health score formula and own the scoring helper | (a) | After T3. |
| `E1-S3` | #22 | Farside repo with CI and a deploy skeleton | switch-on-later | Layout+CI done. Deploy/iac-hub ready to switch on; not blockers. |
| `E1-S3-T1` | #23 | Create the repo and project layout | (a) mostly done | Branch protection is on (owner, 2026-11-02). Leftover: org transfer to `Moonaan/moonaan-farside`. |
| `E1-S3-T2` | #24 | Add CI for lint, types and tests | (a) done | Required check **lint, types and tests** is on. Closed by #222. |
| `E1-S3-T3` | #25 | Deploy an empty service and shell to dev | switch-on-later | Skip when credentials are missing; do not fail CI. |
| `E1-S3-T4` | #26 | Register Farside in iac-hub PRODUCTS | switch-on-later | In-repo `PRODUCTS` sketch only; merge is in iac-hub. |
| `E1-S4` | #27 | Reuse review of existing patterns and adapters | (a) this change | `docs/reuse-review.md`. Sources were readable. |
| `E1-S4-T1` | #28 | Review dashmeta Azure adapter and billing screen | (a) this change | Adapter: one type, fakes-only, extend plan. Billing: plan/usage/amount due/suspend, no invoices. |
| `E1-S4-T2` | #29 | Review AIF connectors and scan for client names | (a) this change | Port vs not-ported lists; scan attached; neither connector live. |
| `E1-S4-T3` | #30 | Map Atlas and cost reporter patterns to checks | (a) this change | Every Azure and GCP launch check is in `docs/reuse/atlas-check-map.json`. |
| `E1-S5` | #31 | Azure test estate seeded with deliberate waste | (c) live leftover | Manifest + skip-apply seed in this change. Subscriptions are not created. |
| `E1-S5-T1` | #32 | Provision the subscriptions and cost guard | (c) | Live Azure. Declared in the manifest, not provisioned. |
| `E1-S5-T2` | #33 | Seed waste, resilience and lifecycle cases from code | (c) + (a) this change | Plan in `docs/azure/ground-truth.json`; ARM apply skipped. Portal listing leftover. |
| `E1-S5-T3` | #34 | Write the ground-truth manifest with exceptions | (a) this change | Every launch check is a case or an exception. |
| `E1-S5-T4` | #35 | Create the empty second subscription with no budget | (c) | Declared as `empty-no-budget`; creating it is live. |
| `E1-S6` | #36 | Azure control spec and app registration settled | (a) this change | Spec, lint, matrix, registration note. Live verify is E1-S7. |
| `E1-S6-T1` | #37 | Write the Azure spec entries | (a) this change | `docs/azure/launch-checks.json`. |
| `E1-S6-T2` | #38 | Settle the app registration approach | adopted | `docs/azure/app-registration.md`. |
| `E1-S6-T3` | #39 | Define the unverified status and the support matrix template | (a) this change | Lint fails without `status`; unverified ⇒ not-supported. |
| `E1-S7` | #40 | Azure roles and APIs verified on the test subscription | (c) | Live role and API runs. |
| `E1-S7-T1` | #41 | Run each role and query with read-only roles | (c) | Live. |
| `E1-S7-T2` | #42 | Prove cross-tenant federated access | (c) | Live. |
| `E1-S7-T3` | #43 | Update the spec with verified status | (a) | After a dated run record. |
| `E1-S7-T4` | #44 | Publish the support matrix | (a) | After run records. |

## E2: Connect Azure and see the estate (#45)

Phase 1 needs Identity, a live Azure connect, and a test tenant.

| Key | Issue | Title | Class | Why |
|---|---|---|---|---|
| `E2` | #45 | Connect Azure and see the estate | (c) live Azure / GCP / test tenant | Phase 1 needs Identity, a live Azure connect, and a test tenant. |
| `E2-S1` | #46 | CTO claims the org and signs in | (d) external system or repo | Moonaan Identity plus AIF Program UI. Claim rehearsal is (c). |
| `E2-S1-T1` | #47 | Set up the console shell using the AIF design | (d) external system or repo | Rebuild navigation from the AIF Program UI design and its accessibility tests. |
| `E2-S1-T2` | #48 | Wire Moonaan Identity into the backend | (d) external system or repo | Validate tokens against Moonaan Identity. |
| `E2-S1-T3` | #49 | Build the sign-in and org claim screens | (d) external system or repo | Sign-in/claim screens against Identity. |
| `E2-S1-T4` | #50 | Enforce org scoping in data access | (a) this change | Cross-org tests on every `/v1` route. Header session until Identity (#48). |
| `E2-S1-T5` | #51 | Rehearse the claim on a test tenant | (c) live Azure / GCP / test tenant | Rehearse claim on a Moonaan Identity test tenant. |
| `E2-S2` | #52 | Connect an Azure subscription with federated credentials | (c) live Azure / GCP / test tenant | Federated Azure connect on a real subscription in another tenant. Spec from E1-S6. |
| `E2-S2-T1` | #53 | Implement federated credential exchange | (c) live Azure / GCP / test tenant | Token exchange against the test subscription; no stored secret. |
| `E2-S2-T2` | #54 | Build the guided Connect screen | (a) this change | Roles, steps, tenant/subscription ids, axe + e2e. Live federated proof is (c). |
| `E2-S2-T3` | #55 | Validate roles and report gaps | (c) live Azure / GCP / test tenant | Role-gap validation by removing roles on the test subscription. |
| `E2-S2-T4` | #56 | Handle disconnect and revoked grants | (c) live Azure / GCP / test tenant | Disconnect and revoke on the test subscription. |
| `E2-S2-T5` | #57 | Add a no-secrets guard to CI | (a) this change | Deliberate leak fails tests; store and responses are scanned. |
| `E2-S3` | #58 | Azure hierarchy and inventory harvest | (c) live Azure / GCP / test tenant | Live harvest vs the seeded manifest. Also (d) dashmeta Resource Graph client and AIF hierarchy. |
| `E2-S3-T1` | #59 | Extend the Resource Graph client to all types | (d) external system or repo | Extend dashmeta's Resource Graph client; proof is a live run (c). |
| `E2-S3-T2` | #60 | Discover management groups and subscriptions | (d) external system or repo | Port hierarchy discovery from AIF connector-azure; live listing (c). |
| `E2-S3-T3` | #61 | Store inventory as aggregates and identifiers | (a) this change | Fixture harvest maps to the inventory contract; payload fields dropped. Live Resource Graph is (c)/(d). |
| `E2-S3-T4` | #62 | Compute no-owner totals | (a) this change | Matches untagged `disk-unattached` in the ground-truth manifest. Live harvest diff is (c). |
| `E2-S3-T5` | #63 | Compare live inventory to ground truth | (c) live Azure / GCP / test tenant | Diff live inventory to ground truth. |
| `E2-S4` | #64 | Coverage model and the Blind spots screen | (a) this change | Coverage + Blind spots over stored/fixture scan data. Live missing-role proof is (c). |
| `E2-S4-T1` | #65 | Record coverage per scope and check | (a) this change | Assessed / unassessed / undetermined unit tests. |
| `E2-S4-T2` | #66 | Use the contract scoring helper for coverage | (a) this change | `scoreHealth` only; unassessed scopes leave the score unchanged. |
| `E2-S4-T3` | #67 | Build the Blind spots screen | (a) this change | Table of why/closer; axe + e2e. |
| `E2-S4-T4` | #68 | Write plain-language reasons for each cause | (a) this change | missing_role, throttling, unsupported_type, failed_call copy. |
| `E2-S5` | #69 | Estate overview, Inventory and Settings screens | (a) this change | Screens over stored/fixture data. Phone-width is jsdom 375 + axe; Playwright device leftover. |
| `E2-S5-T1` | #70 | Build the Estate overview | (a) this change | Totals, no-owner, coverage; no Phase 1 health score. |
| `E2-S5-T2` | #71 | Build the Inventory screen | (a) this change | Filters and grouping; counts compared to the browse API. |
| `E2-S5-T3` | #72 | Build Settings for owner tag and production marker | (a) this change | Changing the owner tag key updates no-owner totals. |
| `E2-S6` | #73 | First scan on connect, running unattended | (c) live leftover | In-repo runner + connect trigger. Live federated unattended is (c). |
| `E2-S6-T1` | #74 | Build the scan job runner | (a) this change | Success and failure job tests. |
| `E2-S6-T2` | #75 | Trigger a scan on connect | (a) this change | Connection PUT starts a scan; live Azure e2e is (c). |
| `E2-S6-T3` | #76 | Prove the unattended path | (c) live Azure / GCP / test tenant | System actor exists in-repo; live federated leftover. |
| `E2-S6-T4` | #77 | Prevent overlapping scans and store failures | (a) this change | Concurrent start and mid-failure tests. |
| `E2-S7` | #78 | Week 8 walk-through and continue-or-stop check | (b) human decision / sign-off | Blocked on D4 (#4). Walk-through itself is (c) on the test estate or the prospect's tenant. |
| `E2-S7-T1` | #79 | Write the demo script and rehearse it | (c) live Azure / GCP / test tenant | Rehearse the sitting on the test subscription. |
| `E2-S7-T2` | #80 | Run the prospect session and record feedback | (b) human decision / sign-off | Prospect session; needs D4 (#4). |
| `E2-S7-T3` | #81 | Record the continue-or-stop decision for Phase 2 | (b) human decision / sign-off | Continue-or-stop record for Phase 2; human decision after the session. |
| `E2-S7-T4` | #82 | Write the pricing floor note | (b) human decision / sign-off | Pricing floor note for Kevin to read. |

## E3: Real Azure issues with proof of coverage (#83)

Phase 2 findings must be proven live. Engine and UI can be built against fixtures first.

| Key | Issue | Title | Class | Why |
|---|---|---|---|---|
| `E3` | #83 | Real Azure issues with proof of coverage | (c) live Azure / GCP / test tenant | Phase 2 findings must be proven live. Engine and UI can be built against fixtures first. |
| `E3-S1` | #84 | Check engine and first check end to end | (a) this change | Engine + unattached-disk against fixtures. Live portal proof is (c). |
| `E3-S1-T1` | #85 | Build the check runner over stored inventory | (a) this change | Runner over stored inventory and facts. No provider calls. |
| `E3-S1-T2` | #86 | Enforce evidence and undetermined rules | (a) this change | Missing evidence and missing closer are rejected. |
| `E3-S1-T3` | #87 | Build the shared savings range helper | (a) this change | min/max + named basis; point values rejected. |
| `E3-S1-T4` | #88 | Add a check registry tied to the spec | (a) this change | Unregistered spec ids cannot run. |
| `E3-S1-T5` | #89 | Add metrics harvest via Monitoring Reader | (c) live Azure / GCP / test tenant | Metrics harvest via Monitoring Reader on the test subscription. |
| `E3-S1-T6` | #90 | Implement the unattached disk check end to end | (a) this change | Fixture positives/negatives via API. Live ARM leftover. |
| `E3-S2` | #91 | Leftover waste checks prove the engine end to end | (a) this change | Three waste checks + Issues list against fixtures. Live scan-to-console is (c). |
| `E3-S2-T1` | #92 | Implement the old snapshot check | (a) this change | Old snapshot vs `snapshot-old` / `snapshot-fresh`; retention from Settings. |
| `E3-S2-T2` | #93 | Implement the unassociated public IP check | (a) this change | Unassociated IP vs `pip-unassociated` / `pip-associated`. |
| `E3-S2-T3` | #94 | Implement the stopped-not-deallocated VM check | (a) this change | Stopped allocated vs deallocated/running. |
| `E3-S2-T4` | #95 | Prove the path from scan to console | (c) live leftover | Fixture Issues list is in this change. Full scan on the test subscription is leftover. |
| `E3-S3` | #96 | Idle plans, load balancers and NAT gateways found | (a) this change | Idle plan/LB/NAT checks against fixtures; busy-gateway negative on the estate is (c). |
| `E3-S3-T1` | #97 | Implement empty App Service plan check | (a) this change | Empty App Service plan check. |
| `E3-S3-T2` | #98 | Implement idle load balancer check | (a) this change | Idle load balancer check. |
| `E3-S3-T3` | #99 | Implement idle NAT gateway check | (a) this change | Idle NAT gateway check. |
| `E3-S3-T4` | #100 | Add the undetermined path for missing metrics | (a) this change | Undetermined path when metrics are missing. |
| `E3-S4` | #101 | Backup and redundancy gaps found, with a Recovery page | (a) this change | Backup/redundancy checks and Recovery page against fixtures; live Backup Reader behaviour is (c). |
| `E3-S4-T1` | #102 | Implement VM and SQL backup coverage check | (a) this change | Fixture protected/unprotected cases. Live vault list is (c). |
| `E3-S4-T2` | #103 | Implement zone redundancy and geo-backup check | (a) this change | Zone redundancy / geo-backup from stored settings; live confirmation (c). |
| `E3-S4-T3` | #104 | Handle unknown production status and missing role | (a) this change | Undetermined paths for unknown production and missing role. |
| `E3-S4-T4` | #105 | Build the Recovery page | (a) this change | Recovery page. |
| `E3-S5` | #106 | Retiring SKUs and expiring certificates, with a Lifecycle page | (a) this change | Retirement data and Lifecycle page are in-repo; near-expiry cert proof is (c). |
| `E3-S5-T1` | #107 | Build the retiring SKU data source | (a) this change | Retiring SKU data with sources. |
| `E3-S5-T2` | #108 | Implement retiring SKU check | (a) this change | Retiring SKU check. |
| `E3-S5-T3` | #109 | Implement certificate expiry check | (a) this change | Fixture near-expiry certs. Live proof is (c). |
| `E3-S5-T4` | #110 | Build the Lifecycle page | (a) this change | Lifecycle page. |
| `E3-S6` | #111 | Issues queue that closes only when covered | (a) this change | Issue store, close-only-if-covered, Issues screen, health score. |
| `E3-S6-T1` | #112 | Create the issue store and identity rule | (a) this change | Issue identity rule. |
| `E3-S6-T2` | #113 | Implement close-only-if-covered logic | (a) this change | Close-only-if-covered. |
| `E3-S6-T3` | #114 | Build the Issues screen | (a) this change | Issues screen. |
| `E3-S6-T4` | #115 | Replay scans to test the lifecycle | (a) this change | Replay scans through the store. |
| `E3-S6-T5` | #116 | Add the health score to the Estate overview | (a) this change | Health score on the overview via the shared helper. |
| `E3-S7` | #117 | Scans screen with history and per-check results | (a) this change | Scans API and screens over stored jobs. Live scan-to-console remains #95. |
| `E3-S7-T1` | #118 | Expose scan history and per-check results in the API | (a) this change | Scan history API. |
| `E3-S7-T2` | #119 | Build the Scans list and detail screens | (a) this change | Scans list and detail. |
| `E3-S7-T3` | #120 | Show live scan progress | (a) this change | Live progress without reload (fake slow scan). |
| `E3-S8` | #121 | Every Azure check run live and accuracy measured | (c) live Azure / GCP / test tenant | Every non-cost check live vs the manifest. D3 (#3). |
| `E3-S8-T1` | #122 | Run all non-cost checks live and record results | (c) live Azure / GCP / test tenant | Run each non-cost check on the test subscription. |
| `E3-S8-T2` | #123 | Diff findings against the manifest | (c) live Azure / GCP / test tenant | Diff findings against the manifest. |
| `E3-S8-T3` | #124 | File and fix defects found | (a) doable in code now | Fix defects in code; rerun is (c). |
| `E3-S8-T4` | #125 | Update the support matrix | (a) doable in code now | Regenerate the support matrix from records. |

## E4: Azure cost, waste, alerts and the CTO headline (#126)

Azure Cost Management and reservations need a live subscription. Floor/burst math is (a).

| Key | Issue | Title | Class | Why |
|---|---|---|---|---|
| `E4` | #126 | Azure cost, waste, alerts and the CTO headline | (c) live Azure / GCP / test tenant | Azure Cost Management and reservations need a live subscription. Floor/burst math is (a). |
| `E4-S1` | #127 | Azure spend harvested and shown by service and month | (a) this change | Multi-page fake harvest, scope/currency, MoM. Portal match is (c) #131. |
| `E4-S1-T1` | #128 | Build the Cost Management harvester with paging | (a) this change | Multi-page fake. Portal match is (c). |
| `E4-S1-T2` | #129 | Record billing scope and currency per figure | (a) this change | Billing scope and currency rules. |
| `E4-S1-T3` | #130 | Compute month-on-month change | (a) this change | Month-on-month change. |
| `E4-S1-T4` | #131 | Verify totals against the portal and note untested agreement types | (c) live Azure / GCP / test tenant | Verify totals against the portal; list untested agreement types. |
| `E4-S2` | #132 | Reservation and savings plan use shown | (a) this change | Fixture utilization and checks. Live harvest is (c) #133. |
| `E4-S2-T1` | #133 | Harvest reservation and savings plan utilization | (c) live leftover | Fixture list exists. Live Reservations Reader run is leftover. |
| `E4-S2-T2` | #134 | Implement the commitment use check | (a) this change | Low-use findings with ranges. |
| `E4-S2-T3` | #135 | Handle none-found and missing-role cases | (a) this change | None-found and missing-role states. |
| `E4-S3` | #136 | Subscriptions without budgets flagged | (a) this change | Seeded empty-no-budget vs main. Live harvest is (c) #137. |
| `E4-S3-T1` | #137 | Harvest budgets per subscription | (c) live leftover | Fixture definitions from the manifest. Live list is leftover. |
| `E4-S3-T2` | #138 | Implement the no-budget check | (a) this change | No-budget check against stored definitions. |
| `E4-S3-T3` | #139 | Add the undetermined path | (a) this change | Undetermined when budgets cannot be read. |
| `E4-S4` | #140 | Floor, burst and spend alerts | (a) this change | Floor, burst, four relative rules, replay suite. Email send is (d). |
| `E4-S4-T1` | #141 | Port floor and burst analysis | (a) this change | Floor and burst analysis. |
| `E4-S4-T2` | #142 | Implement the four alert rules with relative thresholds | (a) this change | Four relative alert rules. |
| `E4-S4-T3` | #143 | Add a backtest regression suite | (a) this change | Synthetic replay suite; live history is (c). |
| `E4-S4-T4` | #144 | Deliver one digest per run by email | (d) external system or repo | Customer-configured email delivery (SES or equivalent in the tenant account). |
| `E4-S5` | #145 | Cost and waste page with named waste | (a) this change | API and assessed totals. Console page is #147 / #243. |
| `E4-S5-T1` | #146 | Expose cost and waste in the API | (a) this change | Cost/waste API. |
| `E4-S5-T2` | #147 | Build the Cost and waste page | (a) leftover | Left for the design-system pass (#243). |
| `E4-S5-T3` | #148 | Compute waste totals from assessed findings only | (a) this change | Waste totals from assessed findings only. |
| `E4-S6` | #149 | CTO headline on the Estate overview | (a) this change | Headline API and unproven-check exclusion. Estate render is #151 / #243. |
| `E4-S6-T1` | #150 | Build the headline data endpoint | (a) this change | Headline endpoint. |
| `E4-S6-T2` | #151 | Render the headline with drill-through links | (a) leftover | Left for the design-system pass (#243). |
| `E4-S6-T3` | #152 | Label unproven checks and exclude them from figures | (a) this change | Exclude checks without a live run record. |
| `E4-S7` | #153 | Every Azure cost check run live and accuracy measured | (c) live Azure / GCP / test tenant | Every Azure cost check live. D3 (#3). |
| `E4-S7-T1` | #154 | Run all cost checks live and record results | (c) live Azure / GCP / test tenant | Run cost checks on the test subscription. |
| `E4-S7-T2` | #155 | Diff findings against the manifest | (c) live Azure / GCP / test tenant | Diff against the manifest. |
| `E4-S7-T3` | #156 | File and fix defects found | (a) doable in code now | Fix defects; rerun is (c). |
| `E4-S7-T4` | #157 | Update the support matrix | (a) doable in code now | Support matrix including untested agreement types. |

## E5: Ready to sell (#158)

Sell-ready path uses iac-hub, Identity, billing (D8), and a test tenant.

| Key | Issue | Title | Class | Why |
|---|---|---|---|---|
| `E5` | #158 | Ready to sell | (d) external system or repo | Sell-ready path uses iac-hub, Identity, billing (D8), and a test tenant. |
| `E5-S1` | #159 | Demo mode with synthetic data | (a) this change | Synthetic demo estate, demo org, Demo label. |
| `E5-S1-T1` | #160 | Generate a synthetic estate fixture | (a) this change | Synthetic fixture generator. |
| `E5-S1-T2` | #161 | Add demo org mode with a visible label | (a) this change | Demo org mode that blocks outbound calls. |
| `E5-S1-T3` | #162 | Run the end-to-end suite against demo mode | (a) this change | Vitest walk of every existing screen on demo data. |
| `E5-S2` | #163 | Scheduled scans that run on their own | (a) this change | Scheduler + Settings. Soak week is (c) #167. |
| `E5-S2-T1` | #164 | Build the recurring scheduler | (a) this change | Recurring scheduler. |
| `E5-S2-T2` | #165 | Add overlap skip, retry and missed-run detection | (a) this change | Overlap skip, retry, missed-run. |
| `E5-S2-T3` | #166 | Add schedule control to Settings | (a) this change | Schedule control in Settings. |
| `E5-S2-T4` | #167 | Run a soak test on the test subscription | (c) live Azure / GCP / test tenant | Unattended soak on the test subscription. |
| `E5-S3` | #168 | Contract and billing for a Farside customer | (a) this change | Contract store and scan gate. Billing screen is #171 / #243. |
| `E5-S3-T1` | #169 | Settle the billing approach and suspension rule | adopted | D8 + E1-S4 billing review in `docs/reuse-review.md`. |
| `E5-S3-T2` | #170 | Store plan and contract state per org | (a) this change | Plan, start, state, amount due. No card numbers. |
| `E5-S3-T3` | #171 | Build the billing screen | (a) leftover | Left for the design-system pass (#243). |
| `E5-S3-T4` | #172 | Apply contract state to scanning | (a) this change | Gate scans on contract state. |
| `E5-S4` | #173 | New customer set up from sale to first scan | (d) external system or repo | iac-hub register, account create, base, Identity, Launch, then Farside. D5 (#5) for the address. Rehearsal is (c). |
| `E5-S4-T1` | #174 | Write the operator runbook | (a) doable in code now | Operator runbook can be written from the proposal path. |
| `E5-S4-T2` | #175 | Automate the Farside deploy for a customer account | (d) external system or repo | Parameterised customer deploy through iac-hub. |
| `E5-S4-T3` | #176 | Rehearse end to end on a test tenant | (c) live Azure / GCP / test tenant | Rehearse sale-to-first-scan on a test tenant. |
| `E5-S4-T4` | #177 | Add rollback and retry notes | (a) doable in code now | Rollback/retry notes from the rehearsal. |
| `E5-S5` | #178 | Customer can leave cleanly | (b) human decision / sign-off | Account retirement follows D8 (#8). Data deletion tests are (a); live account close is (c). |
| `E5-S5-T1` | #179 | Implement data deletion for an org | (a) doable in code now | Org data deletion tests. |
| `E5-S5-T2` | #180 | Remove credentials and stop scans on offboarding | (a) doable in code now | Remove credentials and cancel schedules. |
| `E5-S5-T3` | #181 | Build the offboarding screen and grant list | (a) doable in code now | Offboarding screen. |
| `E5-S5-T4` | #182 | Retire the dedicated account at offboarding | (c) live Azure / GCP / test tenant | Retire the dedicated account; D8 (#8). |
| `E5-S6` | #183 | Export issues, inventory and cost | (a) doable in code now | Export endpoints and buttons over stored aggregates. |
| `E5-S6-T1` | #184 | Build export endpoints with a fixed format | (a) doable in code now | Export API and schema tests. |
| `E5-S6-T2` | #185 | Add export buttons to the screens | (a) doable in code now | Export buttons. |
| `E5-S6-T3` | #186 | Test export scoping and content | (a) doable in code now | Cross-org refusal and no payload fields. |

## E6: Farside covers GCP (#187)

Entire GCP epic needs D7 (#7) and a live project. Collectors also (d) AIF.

| Key | Issue | Title | Class | Why |
|---|---|---|---|---|
| `E6` | #187 | Farside covers GCP | (c) live Azure / GCP / test tenant | Entire GCP epic needs D7 (#7) and a live project. Collectors also (d) AIF. |
| `E6-S1` | #188 | Connect a GCP project with federated credentials | (c) live Azure / GCP / test tenant | GCP connect + test project. D7 (#7). Spec writing T5 is (a). |
| `E6-S1-T1` | #189 | Obtain a GCP test project | (c) live Azure / GCP / test tenant | Funded GCP project with a cost guard. D7 (#7). |
| `E6-S1-T2` | #190 | Implement federated credential exchange for GCP | (c) live Azure / GCP / test tenant | GCP federated credentials on the test project. |
| `E6-S1-T3` | #191 | Build the GCP Connect screen and role validation | (a) doable in code now | GCP Connect screen against fakes; live role removal is (c). |
| `E6-S1-T4` | #192 | Verify the role list live | (c) live Azure / GCP / test tenant | Verify the role list live. |
| `E6-S1-T5` | #193 | Write the GCP control spec | (a) doable in code now | GCP control spec from the proposal table. |
| `E6-S1-T6` | #194 | Enable the billing export on the test project early | (c) live Azure / GCP / test tenant | Enable BigQuery billing export on the test project. |
| `E6-S2` | #195 | GCP inventory by project and type | (c) live Azure / GCP / test tenant | Cloud Asset harvest vs a seeded GCP manifest. Collectors (d) AIF. |
| `E6-S2-T1` | #196 | Seed the GCP test project and manifest | (c) live Azure / GCP / test tenant | Seed the GCP test project from code. |
| `E6-S2-T2` | #197 | Implement the Cloud Asset harvest | (c) live Azure / GCP / test tenant | Cloud Asset harvest live. Port from AIF (d). |
| `E6-S2-T3` | #198 | Compute owner label gaps | (a) doable in code now | Owner-label gaps from stored inventory. |
| `E6-S3` | #199 | GCP waste found | (a) doable in code now | GCP waste checks against fixtures; recommender live run is (c). |
| `E6-S3-T1` | #200 | Implement unattached disk and unused IP checks | (a) doable in code now | Unattached disk and unused IP checks. |
| `E6-S3-T2` | #201 | Implement old snapshot and image checks | (a) doable in code now | Old snapshot and image checks. |
| `E6-S3-T3` | #202 | Turn idle VM and disk recommendations into findings | (c) live Azure / GCP / test tenant | Idle VM/disk recommendations from Recommender. |
| `E6-S3-T4` | #203 | Add savings ranges and the empty-result wording | (a) doable in code now | Savings ranges and empty-result wording. |
| `E6-S4` | #204 | GCP resilience and lifecycle checks | (a) doable in code now | SQL HA/backup, support data, cert expiry. Seeded live proof is (c). |
| `E6-S4-T1` | #205 | Implement Cloud SQL high availability and backup checks | (c) live Azure / GCP / test tenant | Cloud SQL HA/backup against seeded instances. |
| `E6-S4-T2` | #206 | Build SQL and GKE support data and checks | (a) doable in code now | SQL/GKE support data and checks. |
| `E6-S4-T3` | #207 | Implement certificate expiry check | (c) live Azure / GCP / test tenant | Certificate Manager expiry against a seeded cert. |
| `E6-S5` | #208 | GCP billing export onboarding with an empty first day | (c) live Azure / GCP / test tenant | Billing export onboarding needs the live dataset from E6-S1-T6. |
| `E6-S5-T1` | #209 | Detect export state and show onboarding steps | (c) live Azure / GCP / test tenant | Detect export dataset state. |
| `E6-S5-T2` | #210 | Build the empty first-day cost state | (a) doable in code now | Empty first-day cost UI. |
| `E6-S5-T3` | #211 | Show days of history and gate alerts on it | (a) doable in code now | History-day gating of alerts. |
| `E6-S6` | #212 | GCP spend and committed-use discount use | (c) live Azure / GCP / test tenant | BigQuery spend vs the GCP console. Floor/burst reuse is (a). |
| `E6-S6-T1` | #213 | Harvest spend from BigQuery by service and project | (c) live Azure / GCP / test tenant | Harvest spend from BigQuery and compare to the console. |
| `E6-S6-T2` | #214 | Implement committed-use discount check | (c) live Azure / GCP / test tenant | Committed-use discount check live, or mark unverified. |
| `E6-S6-T3` | #215 | Run floor, burst and alerts on GCP data | (a) doable in code now | Reuse Azure floor/burst/alerts on GCP series. |
| `E6-S7` | #216 | GCP in the console and every GCP check run live | (c) live Azure / GCP / test tenant | Two-cloud console plus every GCP check live. Scheduler unattended is (c). |
| `E6-S7-T1` | #217 | Add cloud as a dimension across screens and APIs | (a) doable in code now | Cloud dimension on screens and APIs. |
| `E6-S7-T2` | #218 | Extend the headline to two clouds | (a) doable in code now | Headline across two clouds, no cross-currency sums. |
| `E6-S7-T3` | #219 | Run all GCP checks live and diff against the manifest | (c) live Azure / GCP / test tenant | Run all GCP checks live and diff the manifest. |
| `E6-S7-T4` | #220 | Fix defects and update the support matrix | (a) doable in code now | Fix defects and regenerate the support matrix; rerun is (c). |
