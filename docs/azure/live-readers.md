# Live Azure readers (unverified)

`backend/src/azure-live.ts` holds real read-only clients for the harvest interfaces that had only fixture versions:

| Client | Replaces | Azure call (public REST reference) | Role |
|---|---|---|---|
| `liveMetricsClient` | `fixtureMetricsClient` (#89) | `GET {resource}/providers/microsoft.insights/metrics`, metric `ByteCount`, `Total` | Monitoring Reader |
| `liveCostClient` | `fixtureCostClient` (#131) | `POST {scope}/providers/Microsoft.CostManagement/query`, daily by `ServiceName`, follows `nextLink` | Cost Management Reader |
| `liveBudgetClient` | `fixtureBudgetClient` (#137) | `GET /subscriptions/{id}/providers/Microsoft.Consumption/budgets` | Cost Management Reader |

**None has run against a live subscription.** Shapes come from Microsoft's public reference and are tested only against a mocked `fetch`. They count as built, not verified: the matching checks stay `unverified` and `not-supported` until a dated run record exists (`docs/support-matrix.md`).

Rules the clients keep:

- The token comes from an injected function and is sent only to `https://management.azure.com`. A `nextLink` pointing elsewhere is refused.
- Redirects are refused (`redirect: "error"`), every call has a 30 s timeout, and HTTP 429 or 503 is retried up to 3 times, waiting as `Retry-After` asks (capped at 5 s).
- Resource paths must match a plain `/subscriptions/{id}/...` pattern, and a metric resource must belong to the requested subscription.
- HTTP 403 is a missing role. HTTP 401 is a rejected token and is reported as that, never as a missing role.
- A cost value that is missing or not a finite number fails the read, so it is never recorded as 0.00 or NaN.
- A refused read becomes the missing-role path (or an unreadable budget scope), never an empty result.
- A metric with no data points is "unavailable", not zero traffic, so an unreported gateway is never called idle.
- They are not wired into the scan path yet. `harvestMetrics` and the live harvesters are only called from tests today.

Not built: the reservation and savings plan client (#133). The savings plan utilisation read was not certain enough to write without a live check, and a wrong guess could report "no savings plans" when there are some.
