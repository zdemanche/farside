# E4 remaining work

In-repo Cost Management harvest against a multi-page fake, billing scope and currency on every figure, and month-on-month from two complete months. Portal match and live reservations stay leftover.

## Done here

| Task | Issue | What landed |
|---|---|---|
| E4-S1-T1 | #128 | Fake Cost Management Query client pages through `docs/azure/cost-query-pages.json` and stores the concatenated total. |
| E4-S1-T2 | #129 | Every figure carries `billingScope`, `currency`, and `agreementType`. Mixed-currency sums throw. |
| E4-S1-T3 | #130 | Month-on-month per service from the two latest complete months. The latest day is provisional and excluded from those months. |
| E4-S2-T2 | #134 | Low reservation and savings-plan use fail with an unused-spend range. Well-used commitments pass. |
| E4-S2-T3 | #135 | Empty lists pass as none-found, not zero utilisation. Missing Reservations Reader is unassessed and names the role. |
| E4-S3-T2 | #138 | Seeded `empty-no-budget` fails; `main` with `farside-test-guard` passes. Findings include subscription, evidence, and lastConfirmed. |
| E4-S3-T3 | #139 | Unreadable budgets are `undetermined` with a Cost Management Reader closer. |
| E4-S4-T1 | #141 | Floor is the rolling 14-day minimum; burst is actual minus floor. |
| E4-S4-T2 | #142 | Org, subscription, service, and new-service rules use relative multiples of the customer's own history. |
| E4-S4-T3 | #143 | Synthetic replay in `docs/azure/alert-replay.json` pins four new alerts. A quieter series must change that count on purpose. |
| E4-S5-T1 | #146 | GET `/v1/orgs/:orgId/cost-waste` returns spend, floor/burst, commitments, and named waste. Failed cost harvest returns no figures. |
| E4-S5-T3 | #148 | Waste totals are a range from assessed findings only and count unassessed waste scopes. |

## Leftovers

### Portal totals and agreement types (#131)

The fake pages are not billed months from a live subscription. Compare harvest totals to the Cost Management portal and list untested agreement types when a test estate exists.

### Missing Cost Management Reader live proof

The missing-role path is covered by a fake client. A live 403 from Azure is leftover with E4-S7.

### Live reservation and savings-plan harvest (#133)

The test estate will not buy commitments. Fixture utilization in `docs/azure/commitments.json` is not a live purchase. A dated live run stays leftover.

### Live budget harvest (#137)

Budget definitions are read from the ground-truth manifest. A live Cost Management budgets list stays leftover.

### Cost and waste page (#147)

The API is ready. The console page is left for the design-system pass (#243) so this change does not restyle the shell.

### Email digest (#144)

Alerts group into one digest with configured recipients and consecutive-day dedupe. Delivery needs a mail path in the tenant account. Live test-subscription history for the backtest is leftover with #143.
