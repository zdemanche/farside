# Org transfer checklist: `zdemanche/farside` → `Moonaan/moonaan-farside`

D2 / D5 adopted the name. Part of #23. **Not executed.** Run top to bottom when the owner says go; tick each line in the transfer PR.

## Before

- [ ] Owner of `zdemanche/farside` is an owner (or has repo-create rights) in the `Moonaan` org.
- [ ] No open release-please PR (merge or close it) and no deploy workflow running.
- [ ] Record repo secret, variable and environment names (they stay with the repo on transfer; verify after). Org-level policies on the target may still block them.
  - Secrets in use: `AWS_ROLE_ARN`, `FARSIDE_DEV_ACCOUNT_ID`, `PULUMI_CONFIG_PASSPHRASE`, `PLUGIN_MAINTAIN_TOKEN`. Variable: `PULUMI_SECRETS_PROVIDER`.
  - Environments: `dev`, `customer` (required reviewers, deployment branch `main`).
- [ ] Note branch protection on `main` (required check **lint, types and tests**, squash only).
- [ ] Note open issues/PR counts, labels, milestones (they transfer; check after).

## Transfer

- [ ] Settings → Danger zone → Transfer → `Moonaan`, new name `moonaan-farside` (rename in the same step or right after).
- [ ] GitHub redirects `zdemanche/farside` (web, git, API) to the new repo. Redirects break if anyone creates a new `zdemanche/farside`; do not.

## After: repo settings

- [ ] Branch protection and the required check exist on `main`; re-add if the org has rulesets that override.
- [ ] Squash merge only; "Allow GitHub Actions to create and approve pull requests" on (release-please, plugin-maintain).
- [ ] Environments `dev` and `customer` exist with required reviewers and `main`-only deployment branches; every secret and variable listed above is present (re-enter any that are missing).
- [ ] Actions permissions in the org allow the actions used (`actions/*`, `aws-actions/configure-aws-credentials`, `pulumi/actions`, `googleapis/release-please-action`, `docker/*`).
- [ ] Dependabot (`.github/dependabot.yml`) is enabled for the org.

## After: AWS OIDC

- [ ] Every role trusted by GitHub OIDC changes `sub` from `repo:zdemanche/farside:environment:<env>` to `repo:Moonaan/moonaan-farside:environment:<env>`. Old subject stops matching immediately; deploys fail closed until updated.

## After: code and docs (one PR)

- [ ] `infra/src/product.ts`: `WORKING_REPO` → `Moonaan/moonaan-farside` (or drop it); update `product.test.ts`.
- [ ] `.github/workflows/containers.yml`: `OWNER: zdemanche` → `moonaan`. Images move to `ghcr.io/moonaan/farside-api` and `farside-console`; old GHCR packages do not move. Re-publish from the latest tag; link packages to the repo; set visibility.
- [ ] `docs/releasing.md` GHCR names; `README.md` working-repo line; `docs/branch-rules.md` human branch prefix.
- [ ] Issue links `github.com/zdemanche/farside/issues/N` in docs redirect; rewrite them with a search-and-replace when convenient.
- [ ] `scripts/import_backlog.py` `REPO`.
- [ ] `backend/src/demo.ts` keeps `zdemanche` in its forbidden-name list (demo data must never name it); no change.
- [ ] `docs/operator-runbook.md` OIDC `sub` text; prerequisites table repo row.

## After: release-please

- [ ] `release-please-config.json` has no repo name; nothing to change. First run after transfer: confirm it finds the last `v*` tag and the release PR targets the new repo.
- [ ] GitHub Releases and tags transfer. Check the latest Release still lists its assets.

## After: iac-hub

- [ ] `infra/iac-hub/products-entry.ts` already targets `moonaan-farside`. Open the `PRODUCTS` PR in `Moonaan/iac-hub` now that hub dispatch can reach the repo (#26).

## After: plugin marketplace source

- [ ] `/plugin marketplace add Moonaan/moonaan-farside` works; old `zdemanche/farside` installs keep working through the redirect.
- [ ] Moonaan marketplace entry (#362): `source` → `{ "source": "github", "repo": "Moonaan/moonaan-farside", "path": "plugin" }` (see `docs/plugin-release-checklist.md`).
- [ ] `docs/plugin.md` install lines.

## Verify

- [ ] `git clone https://github.com/zdemanche/farside` redirects; `git remote set-url origin https://github.com/Moonaan/moonaan-farside.git` on every clone.
- [ ] A docs-only PR runs CI and the required check blocks merge until green.
- [ ] `deploy-dev` dispatched from `main` reaches the OIDC step (or skips cleanly if AWS is still unset).
- [ ] release-please opens or updates its PR on the next `feat:`/`fix:` merge.
