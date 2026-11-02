# Farside

A continuous infrastructure product for Azure and GCP. It connects to a cloud estate, scans it, tracks issues, and shows what's costing money, about to break, out of support, or not known to exist.

## Status

The [proposal](docs/proposal.md) is the product brief. [E1-S3](https://github.com/zdemanche/farside/issues/22) added a TypeScript repo layout, CI, and an in-repo deploy skeleton. The empty service is **not** reachable in a Moonaan dev account yet, and `farside` is **not** registered in iac-hub `PRODUCTS`. See [docs/e1-s3-remaining.md](docs/e1-s3-remaining.md).

Working repository: `zdemanche/farside`. Agreed name after [D2](https://github.com/zdemanche/farside/issues/2) and [D5](https://github.com/zdemanche/farside/issues/5): `Moonaan/moonaan-farside`, key `farside`, address `farside.<customer>.moonaan.com`.

## Layout

| Path | What it is |
|---|---|
| `backend/` | Fastify service with `GET /health` |
| `console/` | React/Vite empty shell |
| `infra/` | Pulumi plan, tags, account guard, proposed iac-hub `PRODUCTS` entry |
| `docs/` | Proposal, remaining E1-S3 work, branch rules, backlog triage |
| `backlog/` | Source issues |

Stack rationale: [docs/stack.md](docs/stack.md).

## Develop

Needs Node 22 (see `.nvmrc`).

```bash
npm ci
npm run lint
npm run typecheck
npm run test
npm run build
```

```bash
npm run dev -w @farside/backend   # http://127.0.0.1:8080/health
npm run dev -w @farside/console   # empty shell
```

## Backlog

Work is tracked in [GitHub issues](../../issues), not Jira. Triage of what can be done in code versus what is blocked: [docs/backlog-triage.md](docs/backlog-triage.md).

| Level | Label | What it is |
|---|---|---|
| Epic | `epic` | An outcome someone can see, one per phase |
| Story | `story` | A deliverable piece of an epic, with acceptance criteria |
| Task | `task` | A small unit of work inside a story |

Each story is a sub-issue of its epic, and each task is a sub-issue of its story. Milestones match the build phases, and `decision` marks anything that needs a person to decide.
