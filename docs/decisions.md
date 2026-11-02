# Decisions

Record of D1–D8 and in-story decision points. Each choice is the issue’s stated recommendation, or industry best practice where the issue left a blank.

**Note on every row:** adopted per owner direction, Nov 2 2026.

Physical Azure/GCP tenants, a named paying prospect, and repos this workspace cannot read are still not faked. In-repo work proceeds against fixtures and mocks.

| ID | Issue | Question | Choice | Rationale |
|---|---|---|---|---|
| D1 | #1 | Who builds Azure and GCP infrastructure and cost? | Farside builds infrastructure and cost. Dashmeta keeps security. AWS stays with Atlas. | Same cost scope sits in DAS-775 / DAS-776 with no work started; without a split the work is built twice. |
| D2 | #2 | Separate product, or the Azure/GCP edition of Atlas inside dashmeta? | Separate product on shared scan formats, sold and run continuously. | Atlas is merging into dashmeta; packaging must be deliberate. The Azure/GCP work is the same either way. |
| D3 | #3 | What do we test on? | Fund one Azure subscription, seed it with deliberate waste, plus a second empty subscription with no budget, in a tenant other than the app registration. | No Moonaan Azure subscription is configured here; week-8 accuracy and the cross-tenant connect path need that estate. **Leftover:** the subscriptions do not exist yet (E1-S5). |
| D4 | #4 | Who buys first? | Show Phase 1 around week 8 to one prospect that runs mainly on Azure. Pricing stays above the cost of a dedicated account. | Tests demand before the larger spend. **Leftover:** sales has not named the prospect. |
| D5 | #5 | Does the name Farside clear a trademark search? | Use **Farside** as the product name, key `farside`, repo `Moonaan/moonaan-farside`, address `farside.<customer>.moonaan.com`. | The proposal’s informal search found no security company with the name (closest: Farsight Security). **Leftover:** a formal trademark-counsel search is a legal follow-up, not a code blocker. Working clone remains `zdemanche/farside` until an org transfer. |
| D6 | #6 | May build start? | **Go** for in-repo work (fixtures, mocks, specs, CI). Live Azure proof stays gated on the physical D3 estate. | Owner direction is to proceed. The original three-condition gate still names what live verification needs; it no longer blocks code. |
| D7 | #7 | What do we test GCP on? | Fund one GCP project in a Moonaan-owned organization, with a cost guard, and enable BigQuery billing export as soon as it exists. | GCP cost history starts the day the export is enabled. **Leftover:** no project exists yet (Phase 5 / E6). |
| D8 | #8 | How is Farside billed, and what happens when a contract is unpaid or ends? | Review dashmeta’s billing screen when that repo is readable, then apply: **warning 7 days** (or immediately on failed payment) → **grace 14 days** (product still runs) → **pause new scans** (console read-only) → **retain data 30 days** → **offboard** and retire the dedicated account. | Common SaaS suspension ladder; scanning and account cost continue unless a rule stops them. Period lengths were unset in the issue; these are industry defaults. Dashmeta billing (`BillingHub`) was read 2026-11-02: plan, MLOC meter, amount due, binary suspend — no invoices or payments. Detail in `docs/reuse-review.md`. **Leftover:** implement E5-S3 against that review. |

## In-story decisions

| Source | Question | Choice | Rationale |
|---|---|---|---|
| E1-S1-T4 (#14) | Ryan Morris and Kevin sign-off on D1 | Satisfied by this owner direction. The boundary document records the adoption; it does not claim a personal comment from Ryan or Kevin. | Sign-off steps that only existed to get agreement count as satisfied. |
| E1-S6-T2 (#38) | App registration, federated credentials, cross-tenant test subscription | Multi-tenant app in a Moonaan-owned Entra tenant; **no client secrets**; federated credentials for customer tenants; test subscription in a **different** tenant from the registration. See `docs/azure/app-registration.md`. | Matches the proposal and Entra workload-identity practice. |
| E1-S2-T2 (#18) | Contract additions and Ryan’s sign-off | Farside-local `@farside/scan-contracts` 0.1.0 with evidence, undetermined+closer, savings range, aggregate-only, assessed-only health score. Dashmeta 0.11.0 is not vendored. | Agreement-only sign-off satisfied by owner direction. Additions listed in `docs/scan-contracts.md`. |

Deploy to a dedicated AWS account and iac-hub `PRODUCTS` registration are **switch-on-later integrations**, not blockers. Missing credentials skip those workflows; they do not fail the required CI check.
