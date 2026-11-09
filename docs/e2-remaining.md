# E2 remaining work

In-repo org scoping, a no-secrets guard, the guided Connect screen, inventory mapping, no-owner totals, and standard-OIDC sign-in with the org claim are in this tree. Hooking sign-in to a live Moonaan Identity tenant, live federated Azure connect, and live harvest are leftovers.

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
| E2-S1-T2 | #48 | Bearer JWTs (RS256/ES256) verified against a fetched, cached JWKS (OIDC discovery when no JWKS URL is set); iss, aud, exp, nbf and azp checked; configured org/actor/role claims map onto the session. With `FARSIDE_IDENTITY_ISSUER` set, the header stand-in gets 401. Tests sign with a locally generated key. |
| E2-S1 | #46 | `GET`/`POST /v1/orgs/:orgId/claim`: the first verified user claims the org (owner), later users join (member), repeats are no-ops, each call is audited as `org.claim`. In identity mode every other org route needs membership. Memory and DynamoStore, cross-org 403 kept. |
| E2-S1-T3 | #49 | Console Sign in (authorization code + PKCE) and Claim / Join screens, configured by `VITE_FARSIDE_IDENTITY_*`; the token goes in `sessionStorage` and is sent as a bearer. Vitest + axe, Playwright axe in both themes and the full flow on stubbed provider and API. |
| E2-S1-T1 | #47 | Sign-in screens sit in the Farside shell (skip link, landmarks, title, focus) and the navigation appears once signed in; covered by the shell and e2e accessibility tests. The AIF Program UI design was not readable, so AIF parity is a later review. Nothing was copied from AIF. |
| E2-S1-T5 | #51 | `npm run identity:rehearse` (`scripts/identity-rehearsal/`) runs claim, sign-in, join, org-scoped read and cross-org 403 against a running backend and writes `docs/identity/run-records/<date>-claim-rehearsal.json`. Without a test tenant it prints `skipped: no identity test tenant` and exits 0. |

## Leftovers

### Moonaan Identity tenant hookup (#45, #46, #48, #49, #51)

Only the live tenant hookup remains. Everything is built against standard OIDC and switched on by configuration; no Moonaan Identity internals are assumed (its repo was not readable and no tenant was reachable).

1. Register the console as a public client (authorization code + PKCE) and get the issuer, audience, org claim name and, if any, the role claim from Identity.
2. Backend: set `FARSIDE_IDENTITY_ISSUER`, `FARSIDE_IDENTITY_AUDIENCE`, `FARSIDE_IDENTITY_ORG_CLAIM` (and optionally `FARSIDE_IDENTITY_JWKS_URL`, `_CLIENT_ID`, `_ACTOR_CLAIM`, `_ROLE_CLAIM`, `_CLAIM_ROLE`, `_ALGORITHMS`, `_CLOCK_TOLERANCE_SECONDS`, `_JWKS_CACHE_SECONDS`). Unset, the `x-farside-org` / `x-farside-actor` header session stays as before.
3. Console: build with `VITE_FARSIDE_API_URL`, `VITE_FARSIDE_IDENTITY_ISSUER`, `VITE_FARSIDE_IDENTITY_CLIENT_ID`, `VITE_FARSIDE_IDENTITY_ORG_CLAIM` (see `docs/console-design.md`).
4. Run the claim rehearsal on the test tenant (`scripts/identity-rehearsal/checklist.md`) and commit the dated record.
5. AIF parity review of the shell navigation and its accessibility tests (#47) once the AIF Program UI design is readable.

Not built: provider logout (Sign out is local), token refresh (after `exp`, screens show "Not signed in"; Sign out or a reload returns to Sign in), and owner-only actions beyond the claim.

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
