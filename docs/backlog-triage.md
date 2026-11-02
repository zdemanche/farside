# Backlog triage

Snapshot of every open decision, epic, story and task in `zdemanche/farside` (#1–#220). Nothing was closed, commented on, or edited on GitHub as part of this pass.

## Classes

| Class | Meaning |
|---|---|
| (a) | Doable purely in this repo (code, tests, docs, fixtures) without a live cloud or another team's sign-off. Story predecessors in Farside may still need to land first. |
| (b) | Blocked on a human decision or sign-off. The decision issue is named. |
| (c) | Needs live Azure, GCP, or a Moonaan Identity test tenant. |
| (d) | Depends on an external system or repo (dashmeta, AIF, Atlas, cost reporter, Moonaan Identity, iac-hub, Jira). |

Primary class is what **this item** needs. Many (a) tasks still wait on Farside predecessors that are (b)/(c)/(d).

## Counts

| Class | Items classified |
|---|---|
| (a) doable in code now | 119 |
| (b) human decision / sign-off | 21 |
| (c) live Azure / GCP / test tenant | 59 |
| (d) external system or repo | 21 |

## Recommended next batch (dependency order)

After this E1-S3 change, these are the next stories that can move in code or in-repo docs. Later Azure/GCP stories stay parked until D1/D3/D6 and a test estate exist.

1. **E1-S1 Boundary with dashmeta and Atlas** (#10) — draft T1 (#11) and T3 (#13) from the proposal so D1 (#1) has something to sign. T2 (#12) needs dashmeta Jira (d). T4/T5 are (b)/(d).
2. **E1-S4 Reuse review** (#27) — T1–T3 (#28–#30) are reading Moonaan repos (dashmeta, AIF, atlas-aws, cost reporter) and writing a note here. BlockedBy E1-S1 in the backlog, but the reads do not need D1 closed. Do not copy client data.
3. **E1-S6 Azure control spec** (#31) — T1 (#32) and T3 (#34) are in-repo spec/lint. T2 (#33) is a written registration approach for Ryan and Kevin. Backlog blockedBy E1-S2 and E1-S4; the proposal says the spec can be written from general knowledge before the test subscription exists.
4. **E1-S2 Shared scan contracts** (#16) — only after dashmeta formats are readable (T1 #17) and Ryan signs additions (T2 #18). Then T3–T5 (#19–#21) are in-repo validators, package, and health-score helper.
5. **E2-S1 CTO claim and sign-in** (#38) — unblocked by E1-S3 in the backlog, but T1 (#39) needs the AIF Program UI (d) and T2 (#40) needs Moonaan Identity (d). A navigation shell can start; do not invent Identity.

Do **not** start E1-S5, E1-S7, or anything that claims a live Azure result until D3 (#3) funds a subscription. Do **not** add `farside` to iac-hub until D2 (#2) and D5 (#5) are closed.

## Decisions

| Key | Issue | Title | Class | Why |
|---|---|---|---|---|
| `D1` | #1 | Who builds Azure and GCP infrastructure | (b) human decision / sign-off | Kevin and Ryan Morris must agree Farside vs dashmeta owns Azure/GCP infra and cost. |
| `D2` | #2 | Separate product or inside dashmeta | (b) human decision / sign-off | Kevin and Ryan Morris: separate product vs inside dashmeta. Blocks final repo name and iac-hub entry. |
| `D3` | #3 | Fund an Azure test subscription | (b) human decision / sign-off | Zach and Kevin: fund the Azure test subscription (and a second empty one). Also (c) once funded. |
| `D4` | #4 | Name the first buyer | (b) human decision / sign-off | Kevin and sales: name the first Azure prospect. |
| `D5` | #5 | Trademark search for the Farside name | (b) human decision / sign-off | Zach: trademark search before the name is in a repo or customer address. |
| `D6` | #6 | Go or no-go: all conditions met | (b) human decision / sign-off | Kevin and Zach: go/no-go after D1, D3, and a named prospect saying they would pay. |
| `D7` | #7 | Fund a GCP test project | (b) human decision / sign-off | Zach: fund a GCP test project. Also (c) once funded. |
| `D8` | #8 | Billing approach and suspension rule | (b) human decision / sign-off | Zach: billing approach and suspension/grace/pause/retention periods. |

## E1: Cleared to build and provable on a real Azure estate (#9)

Phase 0 outcome. Mix of sign-off, contracts, repo, spec, and a live Azure estate.

| Key | Issue | Title | Class | Why |
|---|---|---|---|---|
| `E1` | #9 | Cleared to build and provable on a real Azure estate | (b) human decision / sign-off | Phase 0 outcome. Mix of sign-off, contracts, repo, spec, and a live Azure estate. |
| `E1-S1` | #10 | Boundary with dashmeta and Atlas agreed in writing | (b) human decision / sign-off | Story closes only when D1 (#1) is signed by Ryan and Kevin. |
| `E1-S1-T1` | #11 | Write the ownership table and attacker test | (a) doable in code now | Ownership table and attacker-test placements can be drafted from the proposal. |
| `E1-S1-T2` | #12 | List overlaps with DAS-775 and DAS-776 | (d) external system or repo | Needs dashmeta Jira: DAS-775, DAS-776, DAS-923, 942–944, 982, 983, and Ryan reading the list. |
| `E1-S1-T3` | #13 | Record the Jira review and handoff proposal | (a) doable in code now | Jira review/handoff list already written in the proposal; can be copied into a committed note. |
| `E1-S1-T4` | #14 | Get sign-off and close decision D1 | (b) human decision / sign-off | Blocked on D1 (#1): Ryan's and Kevin's written agreement. |
| `E1-S1-T5` | #15 | After sign-off, amend dashmeta and move AIF tickets | (d) external system or repo | Ryan amends dashmeta Jira; Zach moves AIF tickets. After D1 (#1). |
| `E1-S2` | #16 | Shared scan contracts settled with dashmeta | (d) external system or repo | Needs dashmeta scan contracts and Ryan's recorded sign-off on additions. |
| `E1-S2-T1` | #17 | List gaps between dashmeta contracts and Azure/GCP needs | (d) external system or repo | Read dashmeta checks/inventory/coverage/findings formats. |
| `E1-S2-T2` | #18 | Propose and agree contract additions | (b) human decision / sign-off | Ryan's recorded sign-off on each contract addition. |
| `E1-S2-T3` | #19 | Build contract validators and fixtures | (a) doable in code now | Validators and fixtures are in-repo once T1/T2 land. Not startable as the single owner of the format until then. |
| `E1-S2-T4` | #20 | Publish the contracts as a versioned package | (a) doable in code now | Versioned package in this repo after T3. |
| `E1-S2-T5` | #21 | Define the health score formula and own the scoring helper | (a) doable in code now | Health-score helper in this repo after T3. |
| `E1-S3` | #22 | Farside repo with CI and a deploy skeleton | (d) external system or repo | In-repo layout and CI are done in this change. Live deploy and PRODUCTS registration are not. |
| `E1-S3-T1` | #23 | Create the repo and project layout | (a) doable in code now | Repo layout is in this change. Leftover: GitHub branch protection settings, and the Moonaan/moonaan-farside rename after D2 (#2) and D5 (#5). |
| `E1-S3-T2` | #24 | Add CI for lint, types and tests | (a) doable in code now | GitHub Actions CI is in this change. Leftover: mark the check required in repo settings so a failing branch is blocked. |
| `E1-S3-T3` | #25 | Deploy an empty service and shell to dev | (d) external system or repo | Needs a dedicated Moonaan AWS account, OIDC, and a reachable URL. Also D5 (#5) for the hostname. See docs/e1-s3-remaining.md. |
| `E1-S3-T4` | #26 | Register Farside in iac-hub PRODUCTS | (d) external system or repo | Must be merged in Moonaan/iac-hub PRODUCTS. Also D2 (#2) and D5 (#5). |
| `E1-S4` | #27 | Reuse review of existing patterns and adapters | (d) external system or repo | Written review that must read dashmeta, AIF, Atlas, and the cost reporter. No client data is copied. |
| `E1-S4-T1` | #28 | Review dashmeta Azure adapter and billing screen | (d) external system or repo | dashmeta Azure adapter and billing screen. |
| `E1-S4-T2` | #29 | Review AIF connectors and scan for client names | (d) external system or repo | AIF connector-azure / connector-gcp, plus a client-name scan of the AIF repo. |
| `E1-S4-T3` | #30 | Map Atlas and cost reporter patterns to checks | (d) external system or repo | atlas-aws catalog and moonaan-cost-reporter / moonaan-platform-cost. |
| `E1-S5` | #31 | Azure test estate seeded with deliberate waste | (b) human decision / sign-off | Blocked on D3 (#3) and D6 (#6). Execution is (c) live Azure. |
| `E1-S5-T1` | #32 | Provision the subscriptions and cost guard | (c) live Azure / GCP / test tenant | Create Azure subscriptions and a budget in a tenant separate from the app registration. D3 (#3). |
| `E1-S5-T2` | #33 | Seed waste, resilience and lifecycle cases from code | (c) live Azure / GCP / test tenant | Seed waste/resilience/lifecycle resources in that subscription. |
| `E1-S5-T3` | #34 | Write the ground-truth manifest with exceptions | (a) doable in code now | Ground-truth manifest is a file in this repo, but it is only checkable against the seeded estate (c). |
| `E1-S5-T4` | #35 | Create the empty second subscription with no budget | (c) live Azure / GCP / test tenant | Second empty Azure subscription with no budget. D3 (#3). |
| `E1-S6` | #36 | Azure control spec and app registration settled | (a) doable in code now | Spec writing is in-repo from general knowledge. Ryan/Kevin review of the registration note is human, not a numbered decision. |
| `E1-S6-T1` | #37 | Write the Azure spec entries | (a) doable in code now | One spec entry per Azure launch check; lintable in CI. |
| `E1-S6-T2` | #38 | Settle the app registration approach | (b) human decision / sign-off | Ryan and Kevin must review the app-registration / federated-credential note. |
| `E1-S6-T3` | #39 | Define the unverified status and the support matrix template | (a) doable in code now | Unverified/not-supported rule and support-matrix template. |
| `E1-S7` | #40 | Azure roles and APIs verified on the test subscription | (c) live Azure / GCP / test tenant | Live role and API runs on the test subscription. D3 (#3). |
| `E1-S7-T1` | #41 | Run each role and query with read-only roles | (c) live Azure / GCP / test tenant | Run each spec query with only the proposed Azure roles. |
| `E1-S7-T2` | #42 | Prove cross-tenant federated access | (c) live Azure / GCP / test tenant | Cross-tenant federated access against the test subscription. |
| `E1-S7-T3` | #43 | Update the spec with verified status | (a) doable in code now | Mark spec entries verified from run records, after T1. |
| `E1-S7-T4` | #44 | Publish the support matrix | (a) doable in code now | Publish the support matrix from those records. |

## E2: Connect Azure and see the estate (#45)

Phase 1 needs Identity, a live Azure connect, and a test tenant.

| Key | Issue | Title | Class | Why |
|---|---|---|---|---|
| `E2` | #45 | Connect Azure and see the estate | (c) live Azure / GCP / test tenant | Phase 1 needs Identity, a live Azure connect, and a test tenant. |
| `E2-S1` | #46 | CTO claims the org and signs in | (d) external system or repo | Moonaan Identity plus AIF Program UI. Claim rehearsal is (c). |
| `E2-S1-T1` | #47 | Set up the console shell using the AIF design | (d) external system or repo | Rebuild navigation from the AIF Program UI design and its accessibility tests. |
| `E2-S1-T2` | #48 | Wire Moonaan Identity into the backend | (d) external system or repo | Validate tokens against Moonaan Identity. |
| `E2-S1-T3` | #49 | Build the sign-in and org claim screens | (d) external system or repo | Sign-in/claim screens against Identity. |
| `E2-S1-T4` | #50 | Enforce org scoping in data access | (a) doable in code now | Org-scoped data access tests in this repo after Identity is wired. |
| `E2-S1-T5` | #51 | Rehearse the claim on a test tenant | (c) live Azure / GCP / test tenant | Rehearse claim on a Moonaan Identity test tenant. |
| `E2-S2` | #52 | Connect an Azure subscription with federated credentials | (c) live Azure / GCP / test tenant | Federated Azure connect on a real subscription in another tenant. Spec from E1-S6. |
| `E2-S2-T1` | #53 | Implement federated credential exchange | (c) live Azure / GCP / test tenant | Token exchange against the test subscription; no stored secret. |
| `E2-S2-T2` | #54 | Build the guided Connect screen | (a) doable in code now | Connect screen can be built against fakes; live proof is (c). |
| `E2-S2-T3` | #55 | Validate roles and report gaps | (c) live Azure / GCP / test tenant | Role-gap validation by removing roles on the test subscription. |
| `E2-S2-T4` | #56 | Handle disconnect and revoked grants | (c) live Azure / GCP / test tenant | Disconnect and revoke on the test subscription. |
| `E2-S2-T5` | #57 | Add a no-secrets guard to CI | (a) doable in code now | No-secrets CI guard is in-repo. |
| `E2-S3` | #58 | Azure hierarchy and inventory harvest | (c) live Azure / GCP / test tenant | Live harvest vs the seeded manifest. Also (d) dashmeta Resource Graph client and AIF hierarchy. |
| `E2-S3-T1` | #59 | Extend the Resource Graph client to all types | (d) external system or repo | Extend dashmeta's Resource Graph client; proof is a live run (c). |
| `E2-S3-T2` | #60 | Discover management groups and subscriptions | (d) external system or repo | Port hierarchy discovery from AIF connector-azure; live listing (c). |
| `E2-S3-T3` | #61 | Store inventory as aggregates and identifiers | (a) doable in code now | Map harvest results onto the shared inventory contract. |
| `E2-S3-T4` | #62 | Compute no-owner totals | (a) doable in code now | No-owner totals from stored inventory; checkable against the manifest once (c) exists. |
| `E2-S3-T5` | #63 | Compare live inventory to ground truth | (c) live Azure / GCP / test tenant | Diff live inventory to ground truth. |
| `E2-S4` | #64 | Coverage model and the Blind spots screen | (a) doable in code now | Coverage model and Blind spots UI over stored scan data. Needs harvest from E2-S3. |
| `E2-S4-T1` | #65 | Record coverage per scope and check | (a) doable in code now | Coverage states in the check/harvest path. |
| `E2-S4-T2` | #66 | Use the contract scoring helper for coverage | (a) doable in code now | Call the E1-S2 scoring helper; no second implementation. |
| `E2-S4-T3` | #67 | Build the Blind spots screen | (a) doable in code now | Blind spots screen. |
| `E2-S4-T4` | #68 | Write plain-language reasons for each cause | (a) doable in code now | Plain-language reasons; copy review is human but not a numbered decision. |
| `E2-S5` | #69 | Estate overview, Inventory and Settings screens | (a) doable in code now | Estate/Inventory/Settings screens over stored data. Empty states do not need Azure. |
| `E2-S5-T1` | #70 | Build the Estate overview | (a) doable in code now | Estate overview. |
| `E2-S5-T2` | #71 | Build the Inventory screen | (a) doable in code now | Inventory screen. |
| `E2-S5-T3` | #72 | Build Settings for owner tag and production marker | (a) doable in code now | Settings for owner tag and production marker. |
| `E2-S6` | #73 | First scan on connect, running unattended | (c) live Azure / GCP / test tenant | Unattended scan with federated credentials on the test subscription. |
| `E2-S6-T1` | #74 | Build the scan job runner | (a) doable in code now | Job runner can be unit-tested without Azure. |
| `E2-S6-T2` | #75 | Trigger a scan on connect | (a) doable in code now | Trigger-on-connect wiring; end-to-end on the test subscription is (c). |
| `E2-S6-T3` | #76 | Prove the unattended path | (c) live Azure / GCP / test tenant | Prove the unattended path live. |
| `E2-S6-T4` | #77 | Prevent overlapping scans and store failures | (a) doable in code now | Overlap lock and failure persistence. |
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
| `E3-S1` | #84 | Check engine and first check end to end | (a) doable in code now | Check engine, evidence rules, savings helper, unattached-disk check against fixtures. Live seeded-disk proof is (c). |
| `E3-S1-T1` | #85 | Build the check runner over stored inventory | (a) doable in code now | Runner over stored inventory. |
| `E3-S1-T2` | #86 | Enforce evidence and undetermined rules | (a) doable in code now | Evidence and undetermined rejection tests. |
| `E3-S1-T3` | #87 | Build the shared savings range helper | (a) doable in code now | Savings range helper. |
| `E3-S1-T4` | #88 | Add a check registry tied to the spec | (a) doable in code now | Check registry tied to the spec. |
| `E3-S1-T5` | #89 | Add metrics harvest via Monitoring Reader | (c) live Azure / GCP / test tenant | Metrics harvest via Monitoring Reader on the test subscription. |
| `E3-S1-T6` | #90 | Implement the unattached disk check end to end | (c) live Azure / GCP / test tenant | Unattached disk end-to-end against seeded positives/negatives. Fixture path is (a). |
| `E3-S2` | #91 | Leftover waste checks prove the engine end to end | (a) doable in code now | Three waste checks against fixtures; scan-to-console proof on the test estate is (c). |
| `E3-S2-T1` | #92 | Implement the old snapshot check | (a) doable in code now | Old snapshot check. |
| `E3-S2-T2` | #93 | Implement the unassociated public IP check | (a) doable in code now | Unassociated public IP check. |
| `E3-S2-T3` | #94 | Implement the stopped-not-deallocated VM check | (a) doable in code now | Stopped-not-deallocated VM check. |
| `E3-S2-T4` | #95 | Prove the path from scan to console | (c) live Azure / GCP / test tenant | Full scan on the test subscription into the console. |
| `E3-S3` | #96 | Idle plans, load balancers and NAT gateways found | (a) doable in code now | Idle plan/LB/NAT checks against fixtures; busy-gateway negative on the estate is (c). |
| `E3-S3-T1` | #97 | Implement empty App Service plan check | (a) doable in code now | Empty App Service plan check. |
| `E3-S3-T2` | #98 | Implement idle load balancer check | (a) doable in code now | Idle load balancer check. |
| `E3-S3-T3` | #99 | Implement idle NAT gateway check | (a) doable in code now | Idle NAT gateway check. |
| `E3-S3-T4` | #100 | Add the undetermined path for missing metrics | (a) doable in code now | Undetermined path when metrics are missing. |
| `E3-S4` | #101 | Backup and redundancy gaps found, with a Recovery page | (a) doable in code now | Backup/redundancy checks and Recovery page against fixtures; live Backup Reader behaviour is (c). |
| `E3-S4-T1` | #102 | Implement VM and SQL backup coverage check | (c) live Azure / GCP / test tenant | Compare production systems to Azure Backup protected items. |
| `E3-S4-T2` | #103 | Implement zone redundancy and geo-backup check | (a) doable in code now | Zone redundancy / geo-backup from stored settings; live confirmation (c). |
| `E3-S4-T3` | #104 | Handle unknown production status and missing role | (a) doable in code now | Undetermined paths for unknown production and missing role. |
| `E3-S4-T4` | #105 | Build the Recovery page | (a) doable in code now | Recovery page. |
| `E3-S5` | #106 | Retiring SKUs and expiring certificates, with a Lifecycle page | (a) doable in code now | Retirement data and Lifecycle page are in-repo; near-expiry cert proof is (c). |
| `E3-S5-T1` | #107 | Build the retiring SKU data source | (a) doable in code now | Retiring SKU data with sources. |
| `E3-S5-T2` | #108 | Implement retiring SKU check | (a) doable in code now | Retiring SKU check. |
| `E3-S5-T3` | #109 | Implement certificate expiry check | (c) live Azure / GCP / test tenant | Certificate expiry against the seeded near-expiry gateway cert. |
| `E3-S5-T4` | #110 | Build the Lifecycle page | (a) doable in code now | Lifecycle page. |
| `E3-S6` | #111 | Issues queue that closes only when covered | (a) doable in code now | Issue store, close-only-if-covered, Issues screen, health score. No live Azure required for the rule. |
| `E3-S6-T1` | #112 | Create the issue store and identity rule | (a) doable in code now | Issue identity rule. |
| `E3-S6-T2` | #113 | Implement close-only-if-covered logic | (a) doable in code now | Close-only-if-covered. |
| `E3-S6-T3` | #114 | Build the Issues screen | (a) doable in code now | Issues screen. |
| `E3-S6-T4` | #115 | Replay scans to test the lifecycle | (a) doable in code now | Replay scans through the store. |
| `E3-S6-T5` | #116 | Add the health score to the Estate overview | (a) doable in code now | Health score on the overview via the shared helper. |
| `E3-S7` | #117 | Scans screen with history and per-check results | (a) doable in code now | Scans API and screens over stored jobs. |
| `E3-S7-T1` | #118 | Expose scan history and per-check results in the API | (a) doable in code now | Scan history API. |
| `E3-S7-T2` | #119 | Build the Scans list and detail screens | (a) doable in code now | Scans list and detail. |
| `E3-S7-T3` | #120 | Show live scan progress | (a) doable in code now | Live progress without reload (fake slow scan). |
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
| `E4-S1` | #127 | Azure spend harvested and shown by service and month | (c) live Azure / GCP / test tenant | Cost harvest must match the portal, including paging and agreement types. |
| `E4-S1-T1` | #128 | Build the Cost Management harvester with paging | (c) live Azure / GCP / test tenant | Cost Management harvester; multi-page fake is (a), portal match is (c). |
| `E4-S1-T2` | #129 | Record billing scope and currency per figure | (a) doable in code now | Billing scope and currency rules. |
| `E4-S1-T3` | #130 | Compute month-on-month change | (a) doable in code now | Month-on-month change. |
| `E4-S1-T4` | #131 | Verify totals against the portal and note untested agreement types | (c) live Azure / GCP / test tenant | Verify totals against the portal; list untested agreement types. |
| `E4-S2` | #132 | Reservation and savings plan use shown | (c) live Azure / GCP / test tenant | Reservation/savings-plan APIs. Unverified if the test sub has no commitments. |
| `E4-S2-T1` | #133 | Harvest reservation and savings plan utilization | (c) live Azure / GCP / test tenant | Harvest utilization with Reservations Reader. |
| `E4-S2-T2` | #134 | Implement the commitment use check | (a) doable in code now | Low-use findings with ranges. |
| `E4-S2-T3` | #135 | Handle none-found and missing-role cases | (a) doable in code now | None-found and missing-role states. |
| `E4-S3` | #136 | Subscriptions without budgets flagged | (c) live Azure / GCP / test tenant | Budget check against the seeded empty second subscription. D3 (#3). |
| `E4-S3-T1` | #137 | Harvest budgets per subscription | (c) live Azure / GCP / test tenant | Harvest budgets live. |
| `E4-S3-T2` | #138 | Implement the no-budget check | (a) doable in code now | No-budget check against stored definitions. |
| `E4-S3-T3` | #139 | Add the undetermined path | (a) doable in code now | Undetermined when budgets cannot be read. |
| `E4-S4` | #140 | Floor, burst and spend alerts | (a) doable in code now | Floor, burst, four relative rules, replay suite. Email digest needs a mail path (d/infra). Method from cost reporter is (d) to read, (a) to reimplement. |
| `E4-S4-T1` | #141 | Port floor and burst analysis | (a) doable in code now | Floor and burst analysis. Read the cost reporter for method only (d). |
| `E4-S4-T2` | #142 | Implement the four alert rules with relative thresholds | (a) doable in code now | Four relative alert rules. |
| `E4-S4-T3` | #143 | Add a backtest regression suite | (a) doable in code now | Synthetic replay suite; test-subscription history is (c). |
| `E4-S4-T4` | #144 | Deliver one digest per run by email | (d) external system or repo | Customer-configured email delivery (SES or equivalent in the tenant account). |
| `E4-S5` | #145 | Cost and waste page with named waste | (a) doable in code now | Cost and waste page over stored figures and findings. |
| `E4-S5-T1` | #146 | Expose cost and waste in the API | (a) doable in code now | Cost/waste API. |
| `E4-S5-T2` | #147 | Build the Cost and waste page | (a) doable in code now | Cost and waste page. |
| `E4-S5-T3` | #148 | Compute waste totals from assessed findings only | (a) doable in code now | Waste totals from assessed findings only. |
| `E4-S6` | #149 | CTO headline on the Estate overview | (a) doable in code now | CTO headline from stored figures. |
| `E4-S6-T1` | #150 | Build the headline data endpoint | (a) doable in code now | Headline endpoint. |
| `E4-S6-T2` | #151 | Render the headline with drill-through links | (a) doable in code now | Headline UI with drill-through. |
| `E4-S6-T3` | #152 | Label unproven checks and exclude them from figures | (a) doable in code now | Exclude checks without a live run record. |
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
| `E5-S1` | #159 | Demo mode with synthetic data | (a) doable in code now | Synthetic demo estate generated in-repo. Must not call providers. |
| `E5-S1-T1` | #160 | Generate a synthetic estate fixture | (a) doable in code now | Synthetic fixture generator. |
| `E5-S1-T2` | #161 | Add demo org mode with a visible label | (a) doable in code now | Demo org mode that blocks outbound calls. |
| `E5-S1-T3` | #162 | Run the end-to-end suite against demo mode | (a) doable in code now | E2E suite on demo data. |
| `E5-S2` | #163 | Scheduled scans that run on their own | (a) doable in code now | Scheduler and Settings can be tested with time control. Soak week is (c). |
| `E5-S2-T1` | #164 | Build the recurring scheduler | (a) doable in code now | Recurring scheduler. |
| `E5-S2-T2` | #165 | Add overlap skip, retry and missed-run detection | (a) doable in code now | Overlap skip, retry, missed-run. |
| `E5-S2-T3` | #166 | Add schedule control to Settings | (a) doable in code now | Schedule control in Settings. |
| `E5-S2-T4` | #167 | Run a soak test on the test subscription | (c) live Azure / GCP / test tenant | Unattended soak on the test subscription. |
| `E5-S3` | #168 | Contract and billing for a Farside customer | (b) human decision / sign-off | Blocked on D8 (#8) and the dashmeta billing review (d). |
| `E5-S3-T1` | #169 | Settle the billing approach and suspension rule | (b) human decision / sign-off | Apply D8 (#8) and the E1-S4 billing review; Ryan and Kevin read it. |
| `E5-S3-T2` | #170 | Store plan and contract state per org | (a) doable in code now | Store plan/contract state after T1. |
| `E5-S3-T3` | #171 | Build the billing screen | (a) doable in code now | Billing screen after T2. Reuse from dashmeta is (d). |
| `E5-S3-T4` | #172 | Apply contract state to scanning | (a) doable in code now | Gate scans on contract state. |
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
