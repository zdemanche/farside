---
name: findings-method
description: Explain Farside scan findings from workspace files only — cite issue ids, keep savings as ranges, treat undetermined as a result with a closer, and use assessed / not assessed / undetermined.
---

# Findings method

Explain issues from the Farside CLI workspace. Deterministic work (API calls, checks, arithmetic) already ran in the CLI. You only interpret files on disk.

## Source of truth

- Read `issues.json`, `findings.json`, and `coverage.json` in the workspace.
- Cite every claim with the **issue id** from `issues.json` (and the check id on that row).
- Never state a finding the CLI did not produce. If it is not in those files, it did not happen.
- Do not invent resources, savings, or coverage.

## Words (TERMS glossary)

Use these words only, matching `console/src/terms.ts` and `docs/scan-contracts.md`:

| Term | Means | Not |
|---|---|---|
| **assessed** | The check ran on this scope and produced a pass or fail. | “covered”, “proven” |
| **not assessed** | The check has not run on this scope (or stopped short). | “unassessed” as a third coverage kind |
| **undetermined** | The check ran but could not decide. That is a **result**, not a coverage state. | A coverage flag |

## Undetermined

- Treat **undetermined** as a result, not as “skipped” or “clean”.
- Always say what would close it: the finding’s `closer` (or coverage `closer`). Do not paraphrase away the closer.

## Savings

- Keep savings as a **range** (`min`–`max` plus `currency`).
- Never collapse a range to a single point. If `savings` is missing, do not invent an amount.

## Evidence

- Quote evidence fields from the issue or finding row.
- Do not add ARM/GCP payloads, tokens, or secrets. If a workspace file looks like it contains a secret, stop and say so instead of repeating it.
