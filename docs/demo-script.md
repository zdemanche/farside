# Week-8 walk-through script

Script for sitting around **Estate** and **Blind spots** with one prospect (D4). Rehearse on the `demo` org or a fixture scan. A clean rehearsal on the live test subscription is leftover (#79 / #80).

## Setup (5 minutes, off camera)

1. Start the backend and console.
2. Open the console on org `demo` (`VITE_FARSIDE_DEMO=1`) or an org that has finished one fixture scan of `main`.
3. Land on `#estate`. Do not open `#cost-and-waste` — that screen is the design-system leftover.

## Sitting (12 minutes)

### Estate overview — what they own

Say: “This is the estate as Farside last saw it. Totals are resources, resources with no owner tag, and how much of the spec we could actually assess.”

Point at:

- Resource total
- No-owner total (untagged disk in the seed)
- Coverage: assessed / not assessed / undetermined
- Health score only if coverage is assessed; empty state if they have not connected

Do **not** claim a live Azure inventory. If they ask, say the numbers are from the last successful scan.

Click **Blind spots summary**.

### Blind spots — what we could not check

Say: “A blind spot is a check we did not finish. Each row says why and what would close it. We never skip a check; missing evidence is undetermined.”

Walk two rows if present:

1. A **missing role** row — name the role and the checks it blocks.
2. A **not run** or **throttling** row — the next unattended scan retries.

If the demo estate is fully assessed, say so: “This seed has no open blind spots. On a customer tenant you will see missing Reader or Monitoring Reader here on day one.”

Do not invent a finding the Issues list does not show.

### Optional two minutes

If time: `#issues` for the unattached disk, then back to Estate. Stop before cost headlines if the live-run column is still `not-supported`.

## Close

- Ask willingness-to-pay against a price **above** the dedicated-account floor (`docs/pricing-floor.md`).
- Record the answer in the prospect notes (#80). Do not start Phase 2 stories until #81 is filed.

## Leftover

A timed rehearsal on the physical test subscription (#79 check, #80 session).
