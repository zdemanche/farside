# Claim rehearsal checklist (E2-S1-T5, #51)

Rehearses the org claim on a Moonaan Identity **test tenant** against a running Farside backend. No live tenant was reachable when this was written, so no record exists yet. `npm test` runs the runner against an in-process backend that verifies tokens signed by a locally generated key; that proves the runner and the API, not the tenant.

Without the variables below, `npm run identity:rehearse` prints `skipped: no identity test tenant` and exits 0, so CI never fails for a missing tenant.

## Before the run

- [ ] Two test tenants (or orgs) exist in Identity: **A** (the org to claim) and **B** (the cross-org check).
- [ ] Test users: an owner and a second user in A, and one user in B. If the backend sets `FARSIDE_IDENTITY_CLAIM_ROLE`, the owner carries that role.
- [ ] Org A has not been claimed in this backend yet (a re-run passes too: the claim step then reports `outcome existing`).
- [ ] The backend runs with the tenant's settings (values come from Identity; do not guess them):

  | Backend env | Value |
  |---|---|
  | `FARSIDE_IDENTITY_ISSUER` | Test-tenant issuer (exactly the token's `iss`) |
  | `FARSIDE_IDENTITY_AUDIENCE` | Audience(s) the API accepts, comma-separated |
  | `FARSIDE_IDENTITY_ORG_CLAIM` | Claim that names the org |
  | `FARSIDE_IDENTITY_JWKS_URL` | Optional; otherwise read from the issuer's discovery document |
  | `FARSIDE_IDENTITY_CLIENT_ID` | Optional; checked against `azp` when the token has one |
  | `FARSIDE_IDENTITY_ACTOR_CLAIM` | Optional; default `sub` |
  | `FARSIDE_IDENTITY_ROLE_CLAIM`, `FARSIDE_IDENTITY_CLAIM_ROLE` | Optional; role claim and the role needed to claim |

- [ ] Tokens for the three users were obtained from the tenant (for example by signing in to the console built with the matching `VITE_FARSIDE_IDENTITY_*` values). Keep them out of the shell history and the repo.

## Run

```sh
FARSIDE_REHEARSAL_API_URL=https://<backend> \
FARSIDE_REHEARSAL_ISSUER=<issuer> \
FARSIDE_REHEARSAL_ORG_CLAIM=<org claim name> \
FARSIDE_REHEARSAL_OWNER_TOKEN=... \
FARSIDE_REHEARSAL_MEMBER_TOKEN=... \
FARSIDE_REHEARSAL_OTHER_TOKEN=... \
npm run identity:rehearse
```

`FARSIDE_REHEARSAL_ORG` / `FARSIDE_REHEARSAL_OTHER_ORG` name the orgs directly instead of reading them from the tokens. `FARSIDE_REHEARSAL_MEMBER_TOKEN` and `FARSIDE_REHEARSAL_OTHER_TOKEN` are optional (the other org is then required); without them the join and reverse cross-org steps are not run. `FARSIDE_REHEARSAL_OUT` changes the record folder.

## Steps the runner checks

| Step | Expect |
|---|---|
| `header-stand-in-refused` | `x-farside-org` / `x-farside-actor` get 401 (identity mode is on) |
| `claim` | Owner `POST /claim`: 201 `claimed` (or 200 `existing` on a re-run), role owner |
| `claim-idempotent` | Owner claims again: 200 `existing`, still owner |
| `sign-in` | Owner `GET /claim`: member, role owner |
| `join` | Second user `POST /claim`: 200 `joined` (or `existing`), role member |
| `org-scoped-read` | Owner `GET /settings`: 200 |
| `cross-org-403` | Owner reads org B: 403 |
| `cross-org-403-reverse` | User of B reads org A: 403 |
| `cross-org-claim-403` | User of B claims org A: 403 |

## After the run

- [ ] Exit code 0 and `pass` printed. The record is at `docs/identity/run-records/<date>-claim-rehearsal.json`; it holds org ids, statuses and the issuer, never tokens.
- [ ] Commit the record. A `fail` record stays as evidence; fix and re-run rather than editing it.
- [ ] Sign in to the console as the owner and as the second user and confirm the Claim and Join screens, then the Estate.
- [ ] Update `docs/e2-remaining.md` (Identity) with the record's date.
