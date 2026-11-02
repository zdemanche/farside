# AIF client-name scan (E1-S4-T2)

Recorded **before any port** from `Moonaan/moonaan-project-discovery-infrastructure`. No licensee, engagement, or customer names are copied into this repository.

## Query

| Field | Value |
|---|---|
| Date | 2026-11-02 |
| Repo | `Moonaan/moonaan-project-discovery-infrastructure` (default branch) |
| GitHub code search | `repo:Moonaan/moonaan-project-discovery-infrastructure path:docs licensee OR SOW` |
| Connector packages | same query under `packages/connector-azure` and `packages/connector-gcp` |

## Result

| Path | Hits | Kind (no names) |
|---|---|---|
| `docs/requirements/aif-atlas-evidence-engine.md` | yes | One commercial licensee name and one reference-engagement identifier |
| `docs/backlog-atlas-evidence-engine.md` | yes | Same pair restated |
| `packages/connector-azure/**` | none | — |
| `packages/connector-gcp/**` | none | — |

Two documentation files name a licensee and a reference engagement. Connector source, manifests, collectors, and least-privilege role files did not match.

## Action

- Do **not** port those two docs into Farside.
- Do **not** copy the licensee or engagement strings into Farside files, issues, or comments.
- Port lists in `docs/reuse-review.md` cover connector method only.
