# E1-S3 remaining work

In-repo pieces of [E1-S3](https://github.com/zdemanche/farside/issues/22) are in this tree. Live deploy and hub registration are not, and they are not faked.

## Done here

| Task | Issue | What landed |
|---|---|---|
| E1-S3-T1 | #23 | `backend/`, `console/` and `infra/` layout, Node 22, npm workspaces. A clean clone should `npm ci` then `npm run lint`, `typecheck`, `test` and `build`. |
| E1-S3-T2 | #24 | `.github/workflows/ci.yml` runs lint, typecheck and tests on every pull request. |
| E1-S3-T3 (in-repo) | #25 | Pulumi project, tagged resource plan, dedicated-account guard, empty Fastify `/health` service, empty React shell, and deploy workflows. |
| E1-S3-T4 (in-repo) | #26 | Proposed `PRODUCTS` entry at `infra/iac-hub/products-entry.ts`, matching Identity's three-stage dispatch shape. |

## Not done, and why

### E1-S3-T3 — empty service reachable in a dev account (#25)

Acceptance needs a merge to `main` that leaves `/health` and the console shell reachable in a **dedicated** Moonaan-owned dev account, with standard tags and no shared resources.

Blocked on:

1. A dedicated AWS account (or `moonaan-dev`) that is not another product's account. None is configured in this repo. GitHub secrets `AWS_ROLE_ARN` and `FARSIDE_DEV_ACCOUNT_ID` are unset, so `deploy-dev` builds artifacts and **skips** `pulumi up`.
2. GitHub OIDC into that account (Hub uses `repo:Moonaan/*`; this working repo is `zdemanche/farside`).
3. Hosted zone for `farside.<customer>.moonaan.com` after [D5](https://github.com/zdemanche/farside/issues/5).
4. Branch protection requiring the CI job, so a failing check actually blocks merge. This PR cannot turn that setting on.

The Pulumi program (`infra/src/index.ts`) will not create resources until `materializeDevStack` sees the caller account equal the dedicated account id. That is deliberate.

### E1-S3-T4 — register `farside` in iac-hub `PRODUCTS` (#26)

Acceptance needs `farside` in `Moonaan/iac-hub` `event/AccountProvisioner.ts` `PRODUCTS`, with an `iac-hub` plan showing the entry, and a tenant able to list `farside` in `adoptingProducts`.

Blocked on:

1. A pull request **in iac-hub**, not this repo. The hub reads `PRODUCTS` from iac-hub `main`.
2. [D2](https://github.com/zdemanche/farside/issues/2): if Farside is inside dashmeta, this entry should not be added.
3. [D5](https://github.com/zdemanche/farside/issues/5): the agreed repo is `Moonaan/moonaan-farside` and the address is `farside.<customer>.moonaan.com`. Hub dispatch targets the Moonaan org; `zdemanche/farside` is not a valid `targetRepo`.
4. Copying `infra/iac-hub/products-entry.ts` into `PRODUCTS` and adding `farside` to the adopting-products docs in `docs/tenant-registry.md`.

### Repo name and branch rules (#23 leftovers)

- Working clone: `zdemanche/farside`. Agreed name: `Moonaan/moonaan-farside` after D2 and D5.
- Branch rules are written in `docs/branch-rules.md`. Applying them is a GitHub settings action for the owner.

### Story-level acceptance still open (#22)

- CI lint/types/tests: yes, once the workflow is required on the repository.
- Reachable empty service in the dedicated dev account: no.
- iac-hub `PRODUCTS` registration: no.
- No client data copied from the old client-data repo: yes; this tree is original.
