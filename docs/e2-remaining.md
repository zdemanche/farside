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

## Leftovers

### Moonaan Identity (#46, #48, #49)

`x-farside-org` / `x-farside-actor` headers stand in for tokens. Claim and sign-in screens wait on Identity.

### Live federated connect (#52, #53, #55, #56)

Connect does not call Azure. Role-gap, disconnect, and revoked-grant proof need the test subscription.

### Live harvest (#58, #59, #60, #63)

Inventory is mapped from the ground-truth fixture. Resource Graph, management-group discovery, and a live diff wait on Azure and unread dashmeta/AIF clients.

### Live coverage proof

Blind spots is fixture-backed. A missing-role or failed-call row from a live scan waits on E1-S7 / E2-S6.
