# Billing approach

Settled for E5-S3-T1 (#169) from D8 and the 2026-11-02 `BillingHub` review in `docs/reuse-review.md`. Ryan and Kevin sign-off is satisfied by that owner direction, same as other agreement-only steps.

## What Farside bills

Farside bills the **dedicated customer account and the product**, not dashmeta’s MLOC scan meter. Amount due is a decimal string plus currency on the contract. Card numbers, PAN, and CVV are rejected at write time.

There are **no invoices**. Dashmeta had none to copy. `billingView.invoices` stays an empty list.

## Suspension ladder (D8)

Clock starts at `unpaidAt` (failed payment) or immediately when the operator sets warning.

| After | State | Product |
|---|---|---|
| 0 days | `warning` | Scans run. Console writable. |
| 7 days | `grace` | Scans still run. |
| 7 + 14 = 21 days | `paused` | New scans 409. Console read-only. |
| 21 + 30 = 51 days | `retaining` | Data kept. New scans 409. |
| After retain, or contract `ended` | `ended` / offboard | Operator offboards; dedicated account retirement is leftover (#182). |

`active`, `warning`, and `grace` allow scans. `paused`, `retaining`, and `ended` do not. No-contract still allows scans so onboarding is not blocked.

Constants: `WARNING_DAYS = 7`, `GRACE_DAYS = 14`, `RETAIN_DAYS = 30` in `backend/src/billing.ts`.

## Reused from dashmeta `BillingHub`

Screen shape only, when #171 / #243 lands: plan name, status, amount due, suspend/reactivate, usage CSV. Not the MLOC meter, not the binary Active/Suspended flag.

## Rebuilt here

- Contract store: `PUT /v1/orgs/:orgId/contract` (plan, start, state, amount due).
- Scan gate: scheduler and `POST /scans` use `canScan`.
- Ladder above, with failed-payment → paid reset to `active`.
- Offboard already deletes org data (#179). `scripts/offboarding/retire-account.mjs` closes the dedicated account after that (guarded, dry run by default; runbook appendix). `accountClosureAt` in the store stays null; the retirement record carries the date. No account has been retired.

## Leftover

Billing screen (#171) waits on the design-system pass. Payment collection is out of scope — dashmeta had no processor to reuse.
