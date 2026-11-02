# E1-S3 remaining work

In-repo layout, CI, and deploy/iac-hub **skeletons** are in this tree. A dedicated AWS account and iac-hub `PRODUCTS` registration are **switch-on-later integrations**, not blockers. Missing credentials skip those workflows; they must not fail the required CI check.

## Done here

| Task | Issue | What landed |
|---|---|---|
| E1-S3-T1 | #23 | `backend/`, `console/` and `infra/` layout, Node 22, npm workspaces. Branch protection on `main` is on (owner, 2026-11-02). Leftover: org transfer to `Moonaan/moonaan-farside`. |
| E1-S3-T2 | #24 | `.github/workflows/ci.yml` job **lint, types and tests** is the required check. |
| E1-S3-T3 (in-repo) | #25 | Pulumi plan, tags, dedicated-account guard, empty Fastify `/health`, empty React shell, deploy workflows that **skip** when AWS is unset. |
| E1-S3-T4 (in-repo) | #26 | Proposed `PRODUCTS` entry at `infra/iac-hub/products-entry.ts`. |

## Switch on later (not blockers)

### Empty service reachable in a dedicated account (#25)

Needs a dedicated Moonaan AWS account, GitHub OIDC, and a hosted zone for `farside.<customer>.moonaan.com`. Until then `deploy-dev` builds artifacts and skips `pulumi up`.

### `farside` in iac-hub `PRODUCTS` (#26)

Needs a pull request in `Moonaan/iac-hub`. D2 (separate product) and D5 (name) are adopted in `docs/decisions.md`. Hub dispatch still targets the Moonaan org, so `zdemanche/farside` is not a valid `targetRepo` until the org transfer.

### Repo name (#23 leftover)

Working clone: `zdemanche/farside`. Adopted name: `Moonaan/moonaan-farside`.
