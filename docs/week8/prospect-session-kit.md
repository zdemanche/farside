# Week-8 prospect session kit (E2-S7, #78 #80)

For the one Azure prospect named under D4. **No session has been held.** Copy this file to `docs/week8/sessions/<date>-<prospect-code>.md` and fill it in during or straight after the session. Use a code, not the company name, in the filename (client names stay out of the repo).

Script: `docs/demo-script.md`. Price floor: `docs/pricing-floor.md`. Decision after: `docs/week8/continue-or-stop.md`.

## Before (day before)

- [ ] Prospect named by sales (D4). Prospect code chosen: ______
- [ ] Estate: test subscription seeded (`docs/azure/e1-s5-remaining.md`) **or** demo org `demo` (say so out loud if demo).
- [ ] Dry run of `docs/demo-script.md` timed: ____ min (target 12).
- [ ] Console open on `#estate`; Blind spots has at least one row, or the "no open blind spots" line is ready.
- [ ] Price to ask about agreed with Kevin: USD ____ / month (must be above the floor, 70 at time of writing).
- [ ] Note-taker named: ______. Recording consent asked: yes / no.

## Agenda (30 minutes)

| Min | Item | Owner | Source |
|---|---|---|---|
| 0–3 | Who we are, what Farside is, what this is not (not a quote, not their tenant unless connected) | Lead | — |
| 3–5 | Their Azure estate in one minute: subscriptions, who pays, who owns waste | Prospect | Questions A |
| 5–17 | Walk-through: Estate overview → Blind spots → (optional) Issues | Lead | `docs/demo-script.md` "Sitting" |
| 17–25 | Feedback | Note-taker asks | Questions B |
| 25–29 | Willingness to pay | Lead | Questions C |
| 29–30 | Next step and who sends it | Lead | — |

Rules from the script: no live Azure claim unless their tenant is connected; no finding the Issues list does not show; stop before cost headlines while the live-run column is `not-supported`.

## Questions A: their estate

1. How many Azure subscriptions, roughly? Any GCP?
2. Who gets the Azure bill, and who is asked when it jumps?
3. Last time you found something paid-for and unused: what, how found, how long had it run?
4. Do you tag owners? Which key?
5. What do you use today for this (Advisor, Cost Management, a spreadsheet, a consultant)?

## Feedback capture (Questions B)

Fill one row per screen. Quote exact words where you can.

| Screen | What they understood | What confused them | What they asked for | Quote |
|---|---|---|---|---|
| Estate overview | | | | |
| Blind spots | | | | |
| Issues (if shown) | | | | |

Then:

| Question | Answer |
|---|---|
| Which one thing would you act on first? | |
| What is missing that would stop you using it? | |
| Would you connect a subscription in your tenant for a trial? Which role would be the hard one to grant? | |
| Who else would need to say yes? | |
| Anything we showed that you did not believe? | |

## Willingness to pay (Questions C)

Ask in order. Do not anchor below the floor. Write the number they say, not a range we suggest.

1. "If this ran continuously on your estate and you could act on what it found, what would that be worth a month?" → ______
2. "We expect to price at USD {price agreed above} a month for one estate. Is that in budget, a stretch, or out?" → in / stretch / out
3. If stretch or out: "What would have to be true for it to be in?" → ______
4. "Who signs for this kind of spend, and what is their limit without a PO?" → ______
5. "Would you pay for a 30-day trial on your own subscription?" → yes / no / free only

## After (same day)

- [ ] Session file saved under `docs/week8/sessions/` (no client name in the repo; code only).
- [ ] Top three asks copied into the continue-or-stop record.
- [ ] Willingness-to-pay answers copied verbatim into the continue-or-stop record.
- [ ] Follow-up sent by: ______ on ______.
