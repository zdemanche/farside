# E1-S3 remaining work

In-repo layout, CI, deploy/iac-hub skeletons and a per-customer deploy path are in this tree. A dedicated AWS account and iac-hub `PRODUCTS` registration are **switch-on-later integrations**, not blockers. Missing credentials skip every deploy workflow; they must not fail the required CI check. Nothing has been deployed to a dedicated account.

## Done here

| Task | Issue | What landed |
|---|---|---|
| E1-S3-T1 | #23 | `backend/`, `console/` and `infra/` layout, Node 22, npm workspaces. Branch protection on `main` is on (owner, 2026-11-02). Org transfer steps: `docs/org-transfer-checklist.md` (not executed). |
| E1-S3-T2 | #24 | `.github/workflows/ci.yml` job **lint, types and tests** is the required check. |
| E1-S3-T3 (in-repo) | #25 | Pulumi plan, tags, dedicated-account guard, Lambda API + tick, console bucket + CloudFront, DynamoDB store. `deploy-dev` and the iac-hub stage workflows **skip** when AWS is unset. `deploy-customer.yml` deploys one customer from `infra/customers.json` + `infra/accounts.json` without iac-hub; skips without `AWS_ROLE_ARN` and a Pulumi secrets provider. |
| E1-S3-T4 (in-repo) | #26 | Proposed `PRODUCTS` entry at `infra/iac-hub/products-entry.ts`. `products-entry.test.ts` checks every named stage workflow exists, takes the hub inputs, and is dispatch-only and main-only. |

## Switch on later (not blockers)

| Item | Issue | What a person does |
|---|---|---|
| Empty service reachable in a dedicated account | #25 | Create the account, register it in `infra/accounts.json` + `infra/customers.json`, set `AWS_ROLE_ARN` and `PULUMI_CONFIG_PASSPHRASE` (or `PULUMI_SECRETS_PROVIDER`) on the `customer` environment, dispatch `deploy-customer` with `preview: true`, then `false`. |
| `farside` in iac-hub `PRODUCTS` | #26 | PR to `Moonaan/iac-hub` after the org transfer (hub dispatch targets the Moonaan org). |
| Repo name | #23 | Run `docs/org-transfer-checklist.md`. Working clone stays `zdemanche/farside` until then. |
