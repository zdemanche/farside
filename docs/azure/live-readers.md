# Live Azure readers (unverified)

`backend/src/azure-live.ts` holds real read-only clients for the harvest interfaces that had only fixture versions:

| Client | Replaces | Azure call (public REST reference) | Role |
|---|---|---|---|
| `liveMetricsClient` | `fixtureMetricsClient` (#89) | `GET {resource}/providers/microsoft.insights/metrics`, metric `ByteCount`, `Total` | Monitoring Reader |
| `liveCostClient` | `fixtureCostClient` (#131) | `POST {scope}/providers/Microsoft.CostManagement/query`, daily by `ServiceName`, follows `nextLink` | Cost Management Reader |
| `liveBudgetClient` | `fixtureBudgetClient` (#137) | `GET /subscriptions/{id}/providers/Microsoft.Consumption/budgets` | Cost Management Reader |
| `liveResourceGraphClient` (`azure-live-graph.ts`) | `fixtureResourceGraphClient` (#59) | `POST /providers/Microsoft.ResourceGraph/resources` (2022-10-01), subscription-scoped, follows `$skipToken` | Reader |
| `liveHierarchyClient` | `fixtureHierarchyClient` (#60) | Resource Graph `ResourceContainers` (management groups, subscriptions) | Reader |
| `liveProtectedItems` | fixture `protected` facts (#102) | Resource Graph `RecoveryServicesResources` protected items | Backup Reader |
| `liveRoleLister` | `defaultRoleLister` (#55) | `GET .../roleAssignments?$filter=assignedTo('{oid}')` then each role definition | Reader |
| `federatedTokenProvider` (`azure-federated.ts`) | — (#53) | `POST login.microsoftonline.com/{tenant}/oauth2/v2.0/token`, `client_credentials` with `client_assertion` | — |

**None has run against a live subscription.** Shapes come from Microsoft's public reference and are tested only against a mocked `fetch`. They count as built, not verified: the matching checks stay `unverified` and `not-supported` until a dated run record exists (`docs/support-matrix.md`).

Rules the clients keep:

- The token comes from an injected function and is sent only to `https://management.azure.com`. A `nextLink` pointing elsewhere is refused.
- Redirects are refused (`redirect: "error"`), every call has a 30 s timeout, and HTTP 429 or 503 is retried up to 3 times, waiting as `Retry-After` asks (capped at 5 s).
- Resource paths must match a plain `/subscriptions/{id}/...` pattern, and a metric resource must belong to the requested subscription.
- HTTP 403 is a missing role. HTTP 401 is a rejected token and is reported as that, never as a missing role.
- A cost value that is missing or not a finite number fails the read, so it is never recorded as 0.00 or NaN.
- A refused read becomes the missing-role path (or an unreadable budget scope), never an empty result.
- A metric with no data points is "unavailable", not zero traffic, so an unreported gateway is never called idle.
- Resource Graph columns are aliased to the fact names the checks read (`TYPE_PROJECTION`); ages and days left are derived from the scan clock. The SQL `master` database is dropped.

## Federated token (#53)

No secret. Farside's runtime presents its own OIDC token (file named by `FARSIDE_AZURE_ASSERTION_FILE`, else `AZURE_FEDERATED_TOKEN_FILE`, else `AWS_WEB_IDENTITY_TOKEN_FILE`; re-read per exchange) as `client_assertion` to the customer tenant. One cached token per tenant until five minutes before expiry; concurrent callers share one exchange. Errors carry only the HTTP status and an `AADSTS` code. The token is never logged or stored; tests scan every stored aggregate with `assertNoSecrets`. `AZURE_CLIENT_SECRET` is refused.

## Wiring (#58, #73, #76)

Off by default; CI and the fixture/unconfigured paths need no credentials. `FARSIDE_AZURE_LIVE=1` plus `FARSIDE_AZURE_CLIENT_ID` and an assertion file switches the API (`index.ts`, `lambda.ts`) and the unattended scheduler (`scheduled.ts`, actor `system`) to `azureLiveFromEnv`: each scan takes the tenant from the org's Azure connection, harvests Resource Graph, backup and ByteCount facts, and gets per-scan cost and budget clients. Connect lists roles live. Incomplete live config fails at start. Subscriptions with no Azure connection use the fallback harvester. Manual `/cost`, `/commitments`, `/budgets` harvest routes keep their static clients.

Known gaps a live run will judge: Application Gateway certificate expiry is not in ARM, so `azure-lifecycle-expiring-gateway-certs` stays `undetermined`; Azure SQL PaaS backup may not appear as a Backup protected item; load balancer idleness counts backend IP configurations and addresses.

## Live runners (`scripts/azure-live/`)

Each exits 0 with `skipped: no Azure credentials` and writes nothing unless `FARSIDE_AZURE_LIVE=1`, `FARSIDE_AZURE_CLIENT_ID`, an assertion file, `FARSIDE_AZURE_TENANT_ID` and `FARSIDE_AZURE_SUBSCRIPTION_ID` are set. Optional: `FARSIDE_AZURE_EMPTY_SUBSCRIPTION_ID`, `FARSIDE_AZURE_HOME_TENANT_ID` (needed for the cross-tenant proof), `FARSIDE_AZURE_AGREEMENT_TYPE`. Records go to `docs/azure/live-runs/<liveRunAt>-<kind>.json` and name subscriptions by manifest alias only.

| Command | Issues | Writes |
|---|---|---|
| `npm run azure-live:access` | #41, #42 | `access`: exchange, token tenant vs home tenant, roles, each query's outcome |
| `npm run azure-live:checks` | #122/#123, #154/#155, #63 | `checks-noncost`, `checks-cost` (pass = agrees with `ground-truth.json`, with defects), `inventory` |
| `npm run azure-live:cost` | #131 | `cost-totals` with blank portal values and untested agreement types |
| `npm run azure-live:cost -- --compare <file>` | #131 | `cost-portal`: within 0.5% → spend-by-service and month-on-month pass |
| `npm run azure-live:matrix` | #43, #125 | Rewrites `launch-checks.json` status and `support-matrix.md` from records with a `checks` list |

None has been run against Azure. All are tested against `azure-fake.ts`, a fake Entra/ARM built from the manifest.

Not built: the reservation and savings plan client (#133). The savings plan utilisation read was not certain enough to write without a live check, and a wrong guess could report "no savings plans" when there are some.
