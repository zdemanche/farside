# Operator runbook: sale to first scan

Follow these steps in order for one customer. After every step, run its **Check**. If the check fails, use that step’s **Rollback** before retrying. Do not skip a leftover: stop and wait rather than inventing an iac-hub, Identity, or live-tenant action this workspace cannot perform.

This is the written path (#174). Live deploy (#175), a cold rehearsal on a test tenant (#176), and failures found only in that rehearsal (#177 leftover) are not claimed here.

## Prerequisites

| Need | Where it stands |
|---|---|
| Product key `farside` | Adopted (D2, D5). |
| Address | `farside.<customer>.moonaan.com` via `customerAddress()` in `infra/src/product.ts`. Customer slug: lowercase letters, digits, hyphens; 3–30 characters; starts and ends on an alphanumeric. |
| Repo | Adopted name `Moonaan/moonaan-farside`. Working clone is `zdemanche/farside` until org transfer (Part of #23). Hub dispatch waits on that transfer. |
| Dedicated AWS account | Operator-run. Not created from this repo. `assertDedicatedAccount` refuses any other account. |
| iac-hub `PRODUCTS` | In-repo sketch only: `infra/iac-hub/products-entry.ts`. Merge is leftover (#26, #175). |
| Moonaan Identity | Claim and sign-in are leftover. Until then Farside scopes with `x-farside-org` and `x-farside-actor`. |
| Azure app | Multi-tenant registration in a Moonaan-owned home tenant, federated credentials, **no client secret**. Test subscription in a **different** tenant. See `docs/azure/app-registration.md`. Not created from this workspace. |
| Contract state | Operator-token PUT `/v1/orgs/:orgId/contract`. No-contract still allows scans. Paused / retaining / ended block new scans and make the console read-only (D8). |

## Steps

### 1. Record the signed contract {#record-contract}

Operator-run. No card numbers.

```http
PUT /v1/orgs/{orgId}/contract
x-farside-operator: {operator token}
```

```json
{
  "plan": "farside-standard",
  "startDate": "2026-11-03T00:00:00.000Z",
  "currency": "USD",
  "amountDue": "0.00"
}
```

`state` is derived, never submitted: `active`, or `warning` when `unpaidAt` is set. Invoice list is always empty — dashmeta had none to reuse.

**Operator token.** Contract writes (`PUT /contract`, `POST /contract/advance`) need the `x-farside-operator` header to equal the `FARSIDE_OPERATOR_TOKEN` environment variable the backend was started with. An org session (`x-farside-org`) gets 403 on both, and so does every request when `FARSIDE_OPERATOR_TOKEN` is unset or empty. The server clock supplies "now"; a `now` or `asOf` in the body is ignored. Set `unpaidAt` on a failed payment: warning runs 7 days, grace 14, then scans pause and the console is read-only. Data is kept 30 more days (day 51 from `unpaidAt`, or 30 days from the end date) and is then offboarded with a deletion record whose trigger is `retention`: on the org's next request, and by an hourly server-side sweep (`runRetentionSweep`; a future scheduled Lambda calls the same function).

#### Check

- Response is 200 with `contract.plan`, `contract.startDate`, `canScan: true`, and `invoices: []`.
- GET `/v1/orgs/{orgId}/contract` returns the same plan and start date.
- A body with `cardNumber` (or a 13–19 digit PAN) returns 400 `Card data rejected`. Retry without it.

#### Rollback

- Do not store a corrected contract on top of card data: the PUT is rejected and nothing is written.
- Wrong plan or date: PUT again with the corrected fields (no PAN keys).
- If the customer should not scan yet, POST `/v1/orgs/{orgId}/contract/advance` (operator token) with `{ "event": "ended" }` and wait — do not delete the org here.

### 2. Register Farside in iac-hub PRODUCTS {#register-product}

Copy `FARSIDE_IAC_HUB_PRODUCT` from `infra/iac-hub/products-entry.ts` into `Moonaan/iac-hub` `PRODUCTS` (the hub reads that list from iac-hub `main`, not from this repo). `targetRepo` is `moonaan-farside`. Stages: `BackendArtifacts` → `Infra` → `Web`, `workflow_dispatch` only.

**Leftover:** this workspace cannot open that PR. Stop here until someone merges it.

#### Check

- iac-hub `main` lists product key `Farside` / deployment key `farside`.
- Stage workflows match `backend-publish.yml`, `infra-pulumi_up.yaml` (+ `infra-pulumi_destroy.yaml`), `ui-deploy.yml`.

#### Rollback

- If the entry is wrong, revert the iac-hub PR. Do not dispatch customer deploys against a half-registered product.
- If `targetRepo` still points at `zdemanche/farside`, hub dispatch will miss the org — finish the org transfer first, then retry the merge.

### 3. Create the dedicated AWS account {#create-account}

Operator-run account creation (proposal: the account step is operator-run). One Moonaan-owned account per customer. Record the 12-digit account id and the tenant slug.

**Leftover:** no account is created from this repo.

#### Check

- Account id is 12 digits.
- Slug passes `customerAddress(customerName)` (throws otherwise).
- Address will be `farside.{customerName}.moonaan.com`.
- The account is not shared with another product or customer.

#### Rollback

- Bad slug: pick a new slug before any deploy. Do not rename in place after DNS exists.
- Shared or wrong account: do not deploy. `SharedAccountError` is a hard failure. Close or ignore that account and create a dedicated one.
- Accidental create for a cancelled sale: do not deploy Farside; retire the empty account through the same operator path used to create it (#182 leftover).

### 4. Deploy base {#deploy-base}

Deploy the Moonaan tenant **base** into the dedicated account. This repo does not own that stack. Order from the story: base, then Identity, then Launch, then Farside.

**Leftover:** needs iac-hub and a live account (#175).

#### Check

- Base stack in the dedicated account is healthy.
- Account id on the stack matches the id from step 3.

#### Rollback

- Failed apply: retry the same stack once. If it fails again, destroy the partial base stack with the hub destroy for that product before a third attempt.
- Applied to the wrong account: stop. Do not continue to Identity. Destroy and return to step 3.

### 5. Deploy Identity {#deploy-identity}

Deploy Moonaan Identity into the same account so the CTO can later claim the org.

**Leftover:** Identity is not in this repo (#175).

#### Check

- Identity is reachable in the dedicated account.
- The customer org exists (or can be created) for the tenant slug.

#### Rollback

- Failed apply: retry Identity only. Do not redeploy base unless Identity says the base is missing.
- Partial Identity: destroy the Identity stage, leave base in place, retry Identity.
- Until Identity exists, do **not** pretend a claim link works. Use the header session in the appendix for in-repo checks only.

### 6. Deploy Launch {#deploy-launch}

Deploy Moonaan Launch after Identity.

**Leftover:** Launch is not in this repo (#175).

#### Check

- Launch is reachable and points at this customer’s Identity.

#### Rollback

- Failed apply: retry Launch only.
- Launch against the wrong Identity: destroy Launch, fix the Identity pointer, retry. Leave Farside undeployed.

### 7. Deploy Farside {#deploy-farside}

Hub order, `workflow_dispatch` only (never `push` to `main`):

1. `backend-publish.yml` — build backend artifacts.
2. `infra-pulumi_up.yaml` — `organization/farside/{customerName}` in the dedicated account. Inputs: `customerName`, `accountId`, `run_identifier`. Optional: `initialAdmins`, `firstOwnerEmail`, `adoptingProducts`.
3. `ui-deploy.yml` — console.

`materializeDevStack` and `deployStack` call `assertDedicatedAccount` before any resource is declared; current workflows **skip** apply rather than create in the wrong account. `infra/src/program.ts` declares the stack: an API Lambda and a scheduled-tick Lambda (Node 22, arm64) from `backend/dist/lambda.mjs` and `scheduled.mjs`, a Function URL with `AWS_IAM` auth, a private console bucket served by CloudFront (S3 origin with origin access control only), 30-day log groups, an SSM SecureString for the operator token, and an EventBridge Scheduler schedule (`rate(15 minutes)`) that invokes the tick Lambda under a role allowed to invoke only that function. Stack config: `farside:customerName`, `farside:accountId`, `farside:environment`, `farside:logRetentionDays` (optional) and the secret `farside:operatorToken` (`pulumi config set --secret farside:operatorToken`). The token is stored as an SSM SecureString; the Lambda env carries only `FARSIDE_OPERATOR_TOKEN_PARAM`, the role may `ssm:GetParameter` that one parameter and `kms:Decrypt` on the `aws/ssm` key, and the handler reads it once per cold start and fails closed if it cannot. `FARSIDE_OPERATOR_TOKEN` is for local `npm run dev` only. `backend` must be built first (`npm run build -w @farside/backend`).

**The API is not publicly routable yet.** CloudFront serves the console only; there is no `/v1/*` or `/health` behavior. The Function URL stays `AWS_IAM`, so only IAM principals that SigV4-sign can call it (operators with `lambda:InvokeFunctionUrl`). Routing the console to the API through an OAC-signing CloudFront behavior would make `x-farside-org` the only gate, which is not authentication. `assertAuthenticatedEdge` fails the plan if any distribution behavior sends API paths to the Function URL without a viewer authenticator (edge function, WAF or signed cookies). Once Identity (#48) exists, add an Identity-verifying edge function, set `viewerAuthenticator` in the plan, then add the `/v1/*` behavior (TODO: #48). Until then check the deploy with a signed request to the Function URL, for example `awscurl --service lambda <apiUrl>health`.

The Lambda adapter also drops `x-farside-org`, `x-farside-actor` and `x-farside-operator` from every request unless `FARSIDE_TRUST_EDGE_HEADERS=1`, so even a signed caller gets 401 on `/v1` today. Set it on a throwaway dev stack only, never one a customer can reach. Signed `PUT`/`POST` calls need an `x-amz-content-sha256` header holding the body's SHA-256.

The tick Lambda calls the scheduler for every org in its store and runs the retention sweep. The store is in memory per container, so the tick sees only orgs created in its own container until persistence lands; scheduled scans therefore do not yet reach orgs created through the API Lambda.

Every deploy workflow is `workflow_dispatch` only; only `ci.yml` runs on push. A skipped step prints a `::warning::` and a step-summary line saying what was not done. `deploy.yml`, `infra-pulumi_up.yaml` and `infra-pulumi_destroy.yaml` run in the GitHub `dev` / `customer` environments: configure required reviewers on both so a dispatch waits for approval before a job can assume the AWS role (`id-token: write` is granted on those jobs only). Every workflow fails with an `::error::` and a step summary when dispatched from any ref other than `refs/heads/main`, and reads `infra/accounts.json` from `origin/main` rather than the dispatched checkout. Configure both environments with a deployment-branch policy of `main` only, plus required reviewers. The AWS OIDC role trust policy must bind `sub = repo:zdemanche/farside:environment:<name>` (`dev` or `customer`) and `aud = sts.amazonaws.com`; an environment-scoped token carries no ref, so the environment's main-only deployment-branch policy is what enforces the ref. For an IAM-side ref check, customize the repo's OIDC `sub` claim template to include `ref`. Each workflow rejects an `accountId` that is not 12 digits. `accountId` must also be registered to the customer slug in `infra/accounts.json` (merge that change first); the Pulumi guard refuses unregistered, cross-customer and product-dev accounts.

**Leftover:** a real `pulumi up` needs the dedicated account, GitHub OIDC, and Pulumi state (#175).

#### Check

- Backend publish built `backend/dist`.
- Infra plan address is `farside.{customerName}.moonaan.com`. Health path is `/health`.
- After apply is switched on: the console shell loads at the CloudFront host, and a SigV4-signed `GET` of the function URL `/health` returns ok.
- `SharedAccountError` did not fire.

#### Rollback

- Skip (no AWS creds): nothing was created. Fix secrets (`AWS_ROLE_ARN`, `FARSIDE_DEV_ACCOUNT_ID` / account id, Pulumi token) and re-dispatch the same `run_identifier` is fine; a new id is also fine.
- Shared account: treat as fatal. Do not retry against that account.
- Infra failed after artifacts: re-dispatch Infra only. Artifacts can stay.
- Web failed after infra: re-dispatch Web only.
- Need to abandon the customer: `infra-pulumi_destroy.yaml` with `customerName`, `accountId`, `run_identifier`, `destroy` set to true (default false), and `confirm` typed as the exact customer slug, then approve the `customer` environment. Today that workflow no-ops because no stack exists yet. After a real stack exists, destroy Infra, then stop dispatching Backend/Web.

### 8. CTO claims the org and signs in {#claim-org}

The CTO opens the Moonaan Identity **claim link**, claims the org, and signs in. Console host is `farside.{customerName}.moonaan.com`.

**Leftover:** claim and token exchange need Identity (#176). Header session is not a claim.

#### Check

- CTO can sign in and see Farside for that org only.
- Cross-org calls return 403 (same rule as `assertOrgAccess` today).

#### Rollback

- Claim link expired or wrong org: issue a new Identity claim for the same slug. Do not create a second dedicated account.
- CTO lands on the wrong host: fix DNS / Launch pointer; do not redeploy base.
- Until Identity exists, operators verifying the API use the appendix headers. That does not close this step.

### 9. Connect Azure {#connect-azure}

On Connect, follow `CONNECT_STEPS` in `backend/src/roles.ts`:

1. Confirm the Farside app registration is in a Moonaan-owned home tenant.
2. Grant admin consent in the customer tenant.
3. Assign required roles on the subscription: Reader, Cost Management Reader, Monitoring Reader, Reservations Reader. Backup Reader if vault items are needed.
4. Enter tenant id and subscription id. **Never a client secret.**

```http
PUT /v1/orgs/{orgId}/connections
x-farside-org: {orgId}
x-farside-actor: {actor}
```

```json
{ "tenantId": "<entra-tenant>", "subscriptionId": "<subscription>" }
```

Connect starts a scan unless the contract is paused / retaining / ended.

#### Check

- Response is 201 with `tenantId`, `subscriptionId`, and `roles` listing the required set.
- A body with a client secret / token field is rejected.
- If `canScan` is false, `scanStarted` is false and `attention` is `scans paused`. Advance or fix the contract before continuing.
- Test subscription is in a different tenant from the app registration.

#### Rollback

- Secret in the body: rejected, nothing stored. Retry with tenant id and subscription id only.
- Missing role: grant the role in Azure, then PUT the connection again.
- Wrong subscription: DELETE `/v1/orgs/{orgId}/connections/{connectionId}`, then PUT the correct pair.
- Broken connection later: set `healthy: false`; the scheduler will not start a scan (`connection needs attention`). Fix the grant, then PUT again.

### 10. First scan {#first-scan}

Connect already starts a scan. To start one by hand:

```http
POST /v1/orgs/{orgId}/scans
x-farside-org: {orgId}
x-farside-actor: {actor}
```

```json
{ "subscriptionId": "<subscription>" }
```

#### Check

- 202 with `scanStarted: true` and `scan.status` `queued` or `running`, or 200 with `scanStarted: false` if an overlap lock is held (existing job is returned).
- GET `/v1/orgs/{orgId}/scans/{scanId}` reaches `succeeded` and `complete: true`.
- Failed scan is not treated as current. Mid-failure must be `complete: false` and must not publish partial inventory.
- 409 `Scans paused` means the contract is paused / retaining / ended — do not retry the scan; fix billing first.
- Demo org `demo` is not a customer first scan: POSTs return the seed and never call a provider.

#### Rollback

- Overlap: wait for the running job. Do not start a second subscription scan on the same lock.
- Failed job: scheduler retries within `scanRetryLimit` (default 3) at +1h. After the limit, fix the connection or harvest and POST once more.
- Missed schedule: recorded as missed; the next tick starts a new run. Do not backfill by replaying old clocks in production.
- Want a clean retry after a bad connect: wait for the failed job to finish, then POST `/scans` again. Do not mark a failed scan as current.

## Leftovers

| Item | Issue | Why this runbook cannot finish it |
|---|---|---|
| iac-hub `PRODUCTS` merge and parameterised deploy | #26, #175 | Hub and dedicated account are switch-on-later. |
| Cold rehearsal, timing, extra manual steps | #176 | Needs a live test tenant and a dedicated account. |
| Failures found only in that rehearsal | #177 leftover | Notes above cover the known path; new failures get added after #176. |
| Identity claim | E2-S1 / Identity | Header session is the stand-in; the Lambda edge strips it (see step 7). |
| Shared store for API and tick Lambdas | #269 | Both containers hold a private in-memory store. |
| Org transfer | #23 | `Moonaan/moonaan-farside` is not the working clone yet. |
| Live Azure proof | E1-S7, E3-S8 | First scan against a real subscription is leftover. |
| Billing screen / design-system | #171, #243 | Contract is API-only. Do not restyle the console here. |

## Appendix: in-repo dry run (not a customer onboarding)

Use this to walk Farside-owned steps without iac-hub or Identity. It does **not** satisfy #176.

```bash
FARSIDE_OPERATOR_TOKEN=<token> npm run dev -w @farside/backend
```

1. PUT `/v1/orgs/org-a/contract` with the body in step 1 (`x-farside-operator: <token>`).
2. PUT `/v1/orgs/org-a/connections` with `{ "tenantId": "tenant-a", "subscriptionId": "main" }`.
3. GET `/v1/orgs/org-a/scans` and wait for `succeeded`.
4. Optional: PUT the contract with `unpaidAt` 21 days in the past (operator token), then POST `/scans` with the org session and expect 409.

Org `demo` (`VITE_FARSIDE_DEMO=1` on the console) is a synthetic estate. Do not use it as a sale rehearsal.
