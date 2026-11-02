# Reuse review (E1-S4)

Written review of what to reuse, extend, or rebuild. Sources were read on **2026-11-02**. Atlas and the cost reporter are used for **method only**. No client data, licensee names, or engagement identifiers are copied into this repository.

Mechanical map: [`docs/reuse/atlas-check-map.json`](reuse/atlas-check-map.json). Client-name scan: [`docs/reuse/aif-client-name-scan.md`](reuse/aif-client-name-scan.md). Lint fails if any Azure launch check from `docs/azure/launch-checks.json` or any GCP launch check from the proposal table is missing from the map.

## Sources read

| Source | Repo | What was opened |
|---|---|---|
| Dashmeta Azure adapter | `Moonaan/moonaan-dashmeta-cloud` | `src/providers/azure/index.ts`, `src/adapters/azure.ts`, fakes in `src/providers/azure/azure.test.ts` |
| Dashmeta billing | `Moonaan/moonaan-dashmeta-web` | `src/companion/pages/BillingHub.tsx` |
| AIF connectors | `Moonaan/moonaan-project-discovery-infrastructure` | `packages/connector-azure`, `packages/connector-gcp`, least-privilege roles, manifests |
| Atlas catalog | `Moonaan/atlas-aws` | README, `skills/control-catalog` (including `atlas-aws-catalog.cost-seed.yaml`) |
| Cost reporter | `Moonaan/moonaan-cost-reporter` | README, alert rule names in `src/model.ts` / `src/analyze/rules.ts` |

## T1 — Dashmeta Azure adapter and billing screen

### Adapter limits

Dashmeta’s Azure adapter supports **one resource type**: `Microsoft.Storage/storageAccounts`. It evaluates two security checks (anonymous blob access, HTTPS transfer required). `ResourceGraphPort` is injected so tests use a fake; `azure.test.ts` states the path is end-to-end with **no credentials and no network**. Coverage is claimed only for observed locations (deliberate under-claim). The live client (`adapters/azure.ts`) posts one Resource Graph query, pages `$skipToken`, and takes an ARM **bearer token from MSAL client-credentials** (`entra-id-client-credentials` on the AIF/dashmeta side). Projection columns `allowBlobPublicAccess` and `supportsHttpsTrafficOnly` are storage-account-specific; the adapter file says a second type is adapter work, not a new check-pack JSON.

Those two checks are **security**. They stay with dashmeta (D1). Farside does not port them. Farside **does** reuse the Resource Graph port pattern.

### Extend plan (Farside, do not vendor dashmeta)

1. Keep an injected `ResourceGraphPort` (or equivalent) so unit tests stay fakes-only until E1-S7.
2. Widen the KQL query to the types Farside launch checks need. Replace the storage-only `project` clause with a **per-type projection map**.
3. Enumerate metadata only (id, type, location, tags, the fields each check names). Never blob contents, keys, or ACL documents.
4. Auth is **federated credentials, no client secrets** (`docs/azure/app-registration.md`). Do not copy dashmeta’s client-secret token path.
5. Keep harvest and check as separate steps; `runChecks` stays pure over harvested rows where the data was projected in the same query.
6. Keep the under-claim coverage rule: do not invent Azure locations.
7. Reimplement in this repo. Dashmeta’s adapter is UNLICENSED platform code and is not vendored.

Live Resource Graph behaviour against a subscription is E1-S7. Until then the adapter is fakes-only, same as dashmeta today.

### Billing screen (input to E5-S3)

`BillingHub` (`/v2` Billing, DAS-108) offers:

| Offers | Does not offer |
|---|---|
| Plan name, repo limit, included MLOC / month, optional hard ceiling | Stripe (or any) invoices |
| Subscription status Active / Suspended | Card capture or payment processor UI |
| Apply a plan from a catalog | Invoice PDF / line-item invoices |
| This-period usage: scans, LOC scanned, compute cost, cost/LOC | Customer-configured payment collection |
| Computed bill: included / used / overage MLOC, **amount due (USD)** | |
| Admin suspend / reactivate (RBAC-guarded) | |
| Usage CSV export | |

Meter is **scan consumption (MLOC)**, not a dedicated-account cloud bill. Suspend is a binary flag, not D8’s 7 / 14 / 30-day ladder.

**Reuse for E5-S3:** the screen shape (plan, status, amount due, suspend/reactivate, CSV). **Rebuild:** the meter (Farside bills the dedicated account and product, not MLOC), the D8 warning → grace → pause scans → retain 30 days → offboard ladder, and anything that looks like invoicing or payments. Dashmeta has no payment mechanism to copy.

## T2 — AIF connectors and client-name scan

Neither connector has run live. `connector-azure`’s package description is “Injected HTTP/ARM/engine ports; **no live Azure**.” Gate-7 golden fixtures are synthesized. `connector-gcp` collectors take an injected `apiClient`; tests are module-mocked, not a live project.

### `connector-azure` — port

| Piece | Why |
|---|---|
| Least-privilege allowlist | `policies/least-privilege-roles.json`: **Reader** and **Security Reader** only. Owner / Contributor / User Access Administrator refused. |
| Hierarchy discovery | `src/azure-discovery.mjs` and `src/collectors/resource-hierarchy.mjs` (management groups and subscriptions). |
| Resource Graph paging | ARM adapter `$skipToken` vs ARM list `nextLink` as two contracts. |
| Harvest / checkpoint / resume | Bounded pages, idempotent resume, coverage failure on throttle — method, not the Step Functions worker. |
| Workload identity federation | `AZURE_AUTH_METHODS` includes `workload-identity-federation`. Use that; do not port client-credentials. |

Farside launch roles add Cost Management Reader, Monitoring Reader, Reservations Reader, and Backup Reader. Those extend the allowlist; they are not in AIF’s file today. Security Reader stays dashmeta’s posture path.

### `connector-azure` — do not port

Prowler engine and adapter, Atlas evidence writer, posture/security normalizer, Defender / Key Vault / Graph organization types, client-credentials broker, Step Functions state machine, Program UI (rebuild navigation and accessibility tests in a new app), capability-registry ESM as-is.

### `connector-gcp` — port

Collectors **compute-instances**, **storage-buckets**, **resource-hierarchy**; injected read-only REST client; `gcp-discovery.mjs` project/org walk. Method only; rewrite in TypeScript in this repo.

### `connector-gcp` — do not port

**firewall-rules**, **iam-policy-bindings**, **kms-crypto-keys**, **logging-sinks** (security / dashmeta). `security-engine.mjs` and Atlas control-evidence claims. IAM bindings are not a Farside launch check.

### Client-name scan

Completed before this review. Hits: two AIF **docs** files with a licensee name and a reference-engagement identifier. Connector packages: no hits. Names are not copied here. See [`docs/reuse/aif-client-name-scan.md`](reuse/aif-client-name-scan.md).

## T3 — Atlas and cost reporter

Atlas AWS Edition v1.0.0: 130-control catalog, harvest then check, no finding without evidence, `undetermined` with a closer, savings as ranges. Catalog is **AWS-only**. Neutral `ATLAS-*` ids are the portable layer; **no Atlas code ports**.

Every Azure launch check (`docs/azure/launch-checks.json`) and every GCP launch check from the proposal table is in [`docs/reuse/atlas-check-map.json`](reuse/atlas-check-map.json). Summary:

| Atlas pattern | Farside checks |
|---|---|
| Discover / harvest then assess | `azure-inventory-all-resources`, `gcp-inventory-all-assets` |
| ATLAS-CST-041 tag coverage | Azure owner tag, GCP owner label |
| ATLAS-CST-020 idle inventory | Unattached disks, unused public/external IPs, stopped-not-deallocated VMs, idle LBs and NAT, GCP unattached disks and unused IPs |
| ATLAS-CST-021 retention | Old snapshots (Azure); old snapshots and images (GCP) |
| ATLAS-CST-022 utilization triage | GCP idle VM/disk Recommender |
| ATLAS-CST-001 billing telemetry | Azure spend-by-service; GCP BigQuery export spend |
| ATLAS-CST-011 commitment utilization | Azure reservation and savings-plan use; GCP committed-use |
| ATLAS-CST-030 budgets | Azure subscriptions without budgets |
| Backup-coverage method | Azure prod VM/SQL outside Backup; GCP Cloud SQL HA/backup |
| Engine-version / support method | Azure retiring SKUs; GCP SQL/GKE support |
| Certificate-lifecycle method | Azure App Service and gateway certs; GCP Certificate Manager |
| **New** (no Atlas equivalent) | Azure empty App Service plans; Azure DB zone/geo-backup flags |

### Cost reporter — what ports

Ryan’s reporter (`Moonaan/moonaan-cost-reporter`) is an AWS + GitHub digest for Moonaan’s own org. Port the **method**, not the Lambda or Slack wiring.

**Floor vs burst**

- Floor = rolling 14-day *minimum* (what the estate costs when nothing extra is running).
- Burst = actual minus floor.
- Rising floor + flat burst = leftover infrastructure. Flat floor + rising burst = workload.

**Four alert rules (by name)**

| Rule | Condition in the reporter today |
|---|---|
| `ORG_SPIKE` | org day > 1.25 × p95(prior 14d) **and** > mean + $50 |
| `ACCOUNT_SPIKE` | account day > 2 × mean(prior 14d) **and** delta > $25 |
| `SERVICE_SPIKE` | service-in-account day > $100 **and** > 3 × mean |
| `NEW_SERVICE` | service with zero prior-14d spend appears at > $5/day |

Those dollar floors ($50, $25, $100, $5) are tuned to Moonaan’s AWS spend. For Farside they **must become relative and be re-tested**. Do not ship the absolute dollars against a customer Azure or GCP bill.

One digest per run, never one message per alert. Keep a backtest / replay suite (the reporter’s `test/rules.test.ts` pattern). Cost Explorer pagination dropping a silent tail is a lesson for Azure Cost Management paging.

**Do not port:** GitHub Actions rules, Slack `#cost-control` as the product channel, payer-account Lambda, AWS-only waste signatures (`ORPHANED_INGESTION_PIPELINE`, NAT-in-nonprod, and similar).

**Digest channel for Farside:** **customer-configured email**. The reporter itself (as of 2026-11-02) posts to Slack `#cost-control` and keeps SES off unless `EMAIL_DIGEST_ENABLED=true`. Farside does not inherit Slack-only delivery. E4-S4-T4 remains customer-configured email.

## Leftovers

- Live Azure/GCP connector runs (E1-S7, E6).
- Org transfer to `Moonaan/moonaan-farside` (E1-S3-T1).
- Dashmeta / AIF Jira moves (E1-S1-T5).
- Billing implementation (E5-S3) after this review.
- Physical D3 estate (E1-S5 provision).
