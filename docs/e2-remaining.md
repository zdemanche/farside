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
| E2-S3-T1 | #59 | Injected Resource Graph client pages `$skipToken` across every launch type. 429 → `throttling`, other errors → `failed_call`. Default scan path stays the fixture harvester. Live ARG on the test subscription leftover. |
| E2-S2-T3 | #55 | Connect probes roles through an injected `RoleLister` and stores each missing role plus the checks it blocks. Tests remove Cost Management Reader / Backup Reader. Live ARM role list leftover. |

## Leftovers

### Moonaan Identity (#46, #48, #49)

`x-farside-org` / `x-farside-actor` headers stand in for tokens. Claim and sign-in screens wait on Identity.

### Live federated connect (#52, #53, #56)

Connect does not call Azure. Role gaps are stored from an injected lister (#55). Disconnect and revoked-grant proof against a live grant stay leftover.

### Live harvest (#58, #60, #63)

Inventory is mapped from the ground-truth fixture. An injected Resource Graph client pages launch types against that fixture (#59). Management-group discovery and a live ARG diff wait on Azure and unread dashmeta/AIF clients.

### Live coverage proof

Blind spots is fixture-backed. A missing-role or failed-call row from a live scan waits on E1-S7 / E2-S6.

### Unattended federated scan (#76)

The job runner can start as `actor: system` without a user request. Token exchange against a live subscription is still leftover.
