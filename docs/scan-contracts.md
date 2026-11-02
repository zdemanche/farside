# Shared scan contracts (E1-S2)

Farside package: `@farside/scan-contracts` `0.1.0`. This package is the **single owner** of finding/inventory/coverage validators and of the health-score helper. Screens must import `scoreHealth`; they must not reimplement it.

Dashmeta source of record: `Moonaan/moonaan-dashmeta-scan-contracts` `@moonaan/dashmeta-scan-contracts@0.11.0`, approver Ryan Morris. Read on 2026-11-02. That package is UNLICENSED and owned by dashmeta-platform; Farside does **not** vendor it. Results can sit beside Atlas by mapping aggregates, not by copying schemas.

Ryan’s agreement on the additions below is satisfied by owner direction (2026-11-02), not a personal comment. See `docs/decisions.md`.

## Gap table (E1-S2-T1)

Compared with dashmeta’s published cloud triple (CheckPack, SARIF findings, cloud-inventory, coverage) plus cost-fact.

| Azure/GCP need | In dashmeta 0.11.0? | Gap |
|---|---|---|
| Findings with required evidence | SARIF + properties bag; path evidence is a separate document | Farside needs a fail-closed **evidence object on every finding**. |
| `undetermined` + what would close it | Coverage cells `partial` / `unknown` / `blind`; reason-codes on shards | No finding-level `undetermined` + closer. Atlas-style closer is a Farside addition. |
| Savings as a min/max range | Cost-fact `amount` is a decimal string; scenario range exists for finance scenarios | Findings cannot carry a savings **range**. Point values must be rejected. |
| Aggregate-only storage | Inventory is metadata-only (`resourceUri`, type, region, tags, optional monthlyCost string) | Keep that rule. Reject raw ARM/GCP/SDK payload fields. |
| Coverage scopes for Azure subscriptions / GCP projects | Cloud coverage is `(region, resourceTypes)`; exposure coverage is per-route | Need subscription/project + check id, with **assessed vs unassessed**. |
| Health score over assessed scopes | No health-score helper in the package | Farside-owned formula (below). |
| Azure billing scope + currency (MCA/EA) | `COST_PRECISIONS` is `cur` \| `cost-explorer-only` | Azure Cost Management billing-scope/currency is missing. |
| GCP BigQuery billing export / empty first day | Utilization sources are `compute-optimizer` / `cloudwatch-sampled` | GCP export onboarding is missing. |
| Check engine other than Prowler/Steampipe/AI/RA | `ENGINE_KINDS` is AWS-tool vocabulary | Farside launch checks are not those engines. |
| Unverified → not-supported until a live run | Not a dashmeta scan-contract field | Already in Farside Azure spec (`docs/azure/launch-checks.json`). |

Provider enum already includes `azure` and `gcp`. Inventory `subjectRef` already allows `cloud:azure:` and `cloud:gcp:`. Those are **not** gaps; they are unused for Farside’s continuous product until a mapping layer exists.

## Proposed additions (E1-S2-T2)

Each addition is implemented in `@farside/scan-contracts`. A later change to dashmeta’s published package still needs Ryan’s sign-off **in that repo**; this record is the Farside-side agreement.

| Addition | Reason |
|---|---|
| `evidence.fields` required on every finding | No finding without evidence. |
| `result: undetermined` requires `closer` | Atlas rule: say what would close it. |
| `savings: { min, max, currency }` decimal strings | Proposal: savings as ranges, never a point. |
| Forbidden raw payload keys | Only aggregates stored. |
| Coverage `assessed: boolean` per scope | Unassessed scopes contribute nothing to the score. |
| `scoreHealth` in this package | One formula; screens do not reimplement it. |

## Health score

See `HEALTH_SCORE_FORMULA` in `@farside/scan-contracts`. Unassessed scopes are omitted from the score. A fixture with no findings yields **coverage only and `score: null`**.

## Leftover

- Publishing `@farside/scan-contracts` to GitHub Packages (dashmeta’s path) is switch-on-later; the workspace package is the published build for this repo.
- Mapping Farside findings onto dashmeta SARIF for a combined Atlas view is not done.
- Azure billing-scope / GCP export fields land with the cost stories, not this package’s 0.1.0 core.
