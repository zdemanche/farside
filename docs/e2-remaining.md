# E2 remaining work

In-repo org scoping, a no-secrets guard, the guided Connect screen, inventory mapping, and no-owner totals are in this tree. Moonaan Identity, live federated Azure connect, and live harvest are leftovers.

## Done here

| Task | Issue | What landed |
|---|---|---|
| E2-S1-T4 | #50 | Every `/v1/orgs/:orgId` route is session-scoped. Cross-org tests return 403 and do not leak the other org. Header session is a stand-in until Identity. |
| E2-S2-T2 | #54 | Connect screen lists required roles and steps, collects tenant and subscription ids, never asks for a client secret. Vitest e2e + axe. |
| E2-S2-T5 | #57 | `assertNoSecrets` on store writes and responses. A deliberate `client_secret` leak fails CI. |
| E2-S3-T3 | #61 | Ground-truth items map to `@farside/scan-contracts` inventory. Provider payload fields are dropped. |
| E2-S3-T4 | #62 | No-owner totals match the untagged `disk-unattached` row in `docs/azure/ground-truth.json`. |
| E2-S4-T1 | #65 | Coverage states assessed / unassessed / undetermined per scope and check. Harvest marks inventory checks assessed. |
| E2-S4-T2 | #66 | `scoreHealth` from `@farside/scan-contracts` is the only scorer. Adding unassessed scopes leaves the score unchanged. |
| E2-S4-T3 | #67 | Blind spots screen lists why and what would close it. Vitest e2e + axe. |
| E2-S4-T4 | #68 | Missing role, throttling, unsupported type, and failed call map to plain-language copy. |
| E2-S5-T1 | #70 | Estate overview: totals, no-owner, coverage, no Phase 1 health score. Empty state points to Connect. |
| E2-S5-T2 | #71 | Inventory browse with owner/service/subscription/region filters and owner/service grouping. |
| E2-S5-T3 | #72 | Settings store owner tag and production marker per org; changing the owner key updates no-owner totals. |
| E2-S6-T1 | #74 | Background scan job with stored success and failure status. |
| E2-S6-T2 | #75 | Connect (connection PUT) starts the first scan. |
| E2-S6-T4 | #77 | One running scan per subscription; mid-failure stores covered scopes and is not marked complete. |
| E2-S7-T1 | #79 | `docs/demo-script.md` scripts Estate and Blind spots. Live rehearsal on the test subscription leftover. |
| E2-S7-T4 | #82 | `docs/pricing-floor.md` compares an estimated dedicated-account plus test-estate cost. Kevin replaces the ranges from actuals. |
| E2-S3-T1 | #59 | Injected Resource Graph client pages `$skipToken` across every launch type. 429 → `throttling`, other errors → `failed_call`. Default scan path stays the fixture harvester. Live ARG on the test subscription leftover. |
| E2-S2-T3 | #55 | Connect probes roles through an injected `RoleLister` and stores each missing role plus the checks it blocks. Tests remove Cost Management Reader / Backup Reader. Live ARM role list leftover. |
| E2-S3-T2 | #60 | Injected hierarchy client lists the fixture root/test management groups and both ground-truth subscriptions. Live ARM listing leftover. |
| E2-S2-T4 | #56 | Re-probe `POST .../connections/:id/roles` marks a revoked grant `healthy: false`. DELETE removes the connection. Live revoke on the test subscription leftover. |

## Leftovers

### Moonaan Identity (#46, #48, #49)

`x-farside-org` / `x-farside-actor` headers stand in for tokens. Claim and sign-in screens wait on Identity.

### Live federated connect (#52, #53)

Connect does not call Azure. Role gaps (#55) and a revoked-grant re-probe (#56) use an injected lister. Token exchange against the test subscription stays leftover.

### Live harvest (#58, #63)

Inventory is mapped from the ground-truth fixture. Resource Graph paging (#59) and hierarchy discovery (#60) run against that fixture. A live ARG diff waits on Azure.

### Live coverage proof

Blind spots is fixture-backed. A missing-role or failed-call row from a live scan waits on E1-S7 / E2-S6.

### Unattended federated scan (#76)

The job runner can start as `actor: system` without a user request. Token exchange against a live subscription is still leftover.

### Week-8 session (#80, #81)

The Estate / Blind spots script is written (`docs/demo-script.md`). The prospect sitting, willingness-to-pay notes, and the continue-or-stop record stay leftover.
