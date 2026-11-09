# Continue-or-stop decision record template (E2-S7-T3, #81)

**Template. No decision has been made.** Copy to `docs/week8/decisions/<date>-continue-or-stop.md` after the prospect session (`docs/week8/prospect-session-kit.md`). One record per decision. Phase 2 stories do not start until a filed record says **continue**.

## Record

| Field | Value |
|---|---|
| Date | |
| Decision | continue / continue with changes / stop |
| Decided by | Kevin + owner (names) |
| Session file | `docs/week8/sessions/<file>` |
| Estate shown | test subscription / demo org / prospect tenant |
| Prospect code | |

## Evidence

| Question | Answer | Source |
|---|---|---|
| Did the prospect understand Estate and Blind spots without help? | yes / partly / no | session feedback table |
| Top three asks | 1. 2. 3. | session |
| Willingness to pay (verbatim) | | session Questions C |
| Price asked vs floor (`docs/pricing-floor.md`) | USD __ vs USD __ | |
| In budget / stretch / out | | |
| Would they connect a subscription for a trial? | | |
| Blockers named (roles, approvals, security review) | | |
| Live accuracy on the test estate (E3-S8) | run record date, or "not run" | `docs/azure/support-matrix.md` |

## Criteria

Continue needs all of:

- [ ] Prospect said a number at or above the floor, or "in budget" / "stretch" at the asked price.
- [ ] At least one finding type they would act on first.
- [ ] No blocker that Phase 2 cannot address (state which story addresses each).

Stop if any:

- [ ] Price answer is "out" with no path to "in".
- [ ] They would not connect a subscription even for a trial, and the reason is not addressable.
- [ ] The screens did not land and the fix is not a Phase 2 story.

## Decision

Write two to five sentences: what we decided, why, and what changes.

## If continue

| Phase 2 change from feedback | Story / issue |
|---|---|
| | |

## If stop

| What happens | Owner | By |
|---|---|---|
| Pause Phase 2 issues (label, not delete) | | |
| Keep the test estate or `--destroy` it (`scripts/azure-estate/seed.mjs`) | | |
| Tell the prospect | | |

## Sign-off

| Person | Agrees | Date |
|---|---|---|
| Kevin | | |
| Owner | | |
