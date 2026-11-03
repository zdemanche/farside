# E4 remaining work

In-repo Cost Management harvest against a multi-page fake, billing scope and currency on every figure, and month-on-month from two complete months. Portal match and live reservations stay leftover.

## Done here

| Task | Issue | What landed |
|---|---|---|
| E4-S1-T1 | #128 | Fake Cost Management Query client pages through `docs/azure/cost-query-pages.json` and stores the concatenated total. |
| E4-S1-T2 | #129 | Every figure carries `billingScope`, `currency`, and `agreementType`. Mixed-currency sums throw. |
| E4-S1-T3 | #130 | Month-on-month per service from the two latest complete months. The latest day is provisional and excluded from those months. |

## Leftovers

### Portal totals and agreement types (#131)

The fake pages are not billed months from a live subscription. Compare harvest totals to the Cost Management portal and list untested agreement types when a test estate exists.

### Missing Cost Management Reader live proof

The missing-role path is covered by a fake client. A live 403 from Azure is leftover with E4-S7.
