# Farside

A continuous infrastructure product for Azure and GCP. It connects to a cloud estate, scans it, tracks issues, and shows what's costing money, about to break, out of support, or not known to exist.

## Status

The [proposal](docs/proposal.md) is the product brief. Decisions D1–D8 are recorded in [docs/decisions.md](docs/decisions.md). Boundary: [docs/boundary.md](docs/boundary.md). Scan contracts: [docs/scan-contracts.md](docs/scan-contracts.md). Azure launch spec: [docs/azure/launch-checks.json](docs/azure/launch-checks.json), [support matrix](docs/azure/support-matrix.md), [app registration](docs/azure/app-registration.md). GCP launch spec: [docs/gcp/launch-checks.json](docs/gcp/launch-checks.json), [support matrix](docs/gcp/support-matrix.md), [ground-truth fixtures](docs/gcp/ground-truth.json).

[E1-S3](https://github.com/zdemanche/farside/issues/22) added a TypeScript repo layout, CI, and an in-repo deploy skeleton. Dedicated AWS deploy and iac-hub `PRODUCTS` registration are switch-on-later integrations; they are not blockers. See [docs/e1-s3-remaining.md](docs/e1-s3-remaining.md). Sale-to-first-scan steps: [docs/operator-runbook.md](docs/operator-runbook.md). Releases: [docs/releasing.md](docs/releasing.md).

Working repository: `zdemanche/farside`. Adopted name: `Moonaan/moonaan-farside`, key `farside`, address `farside.<customer>.moonaan.com`.

## Layout

| Path | What it is |
|---|---|
| `backend/` | Fastify service with `GET /health` |
| `console/` | React/Vite empty shell |
| `contracts/` | Scan-contract validators and the health-score helper |
| `infra/` | Pulumi plan, tags, account guard, proposed iac-hub `PRODUCTS` entry |
| `docs/` | Proposal, decisions, boundary, Azure spec, remaining E1-S3 work, branch rules, backlog triage |
| `scripts/azure-spec/` | Lint that fails on a missing spec field or missing `status` |
| `scripts/gcp-estate/` | Lint that the GCP seed has owner-label positives and negatives |
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

Work is tracked in [GitHub issues](../../issues), not Jira. Re-triage (what is in-repo vs live cloud vs unread externals): [docs/backlog-triage.md](docs/backlog-triage.md).

| Level | Label | What it is |
|---|---|---|
| Epic | `epic` | An outcome someone can see, one per phase |
| Story | `story` | A deliverable piece of an epic, with acceptance criteria |
| Task | `task` | A small unit of work inside a story |

Each story is a sub-issue of its epic, and each task is a sub-issue of its story. Milestones match the build phases, and `decision` marks anything that needs a person to decide.
