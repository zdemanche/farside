# Branch rules

These are the rules E1-S3-T1 calls for. Branch protection on `main` (required check **lint, types and tests**) was turned on by the owner on 2026-11-02.

## `main`

- No direct pushes. Every change lands through a pull request.
- The check named **lint, types and tests** (`CI` / job `lint, types and tests`) is required. A failing run blocks merge.
- No force-push, no `--no-verify`, no admin bypass of the required check.
- Deploy to a customer account is **not** triggered by `push` to `main`. iac-hub workflows are `workflow_dispatch` only so they do not fight the provisioner.

## Feature branches

- Named `cursor/<short-name>-0052` for agent work, or a conventional `zdemanche/<short-name>` for humans.
- Rebase or merge `main` before asking for review.

## Required local commands (clean clone)

```bash
npm ci
npm run lint
npm run typecheck
npm run test
npm run build
```
