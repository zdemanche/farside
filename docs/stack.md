# Stack choice

The proposal names a React/TypeScript console, Moonaan Identity, and iac-hub `PRODUCTS` registration. It does not name a backend or IaC language.

This repo uses:

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript, Node 22 | Same as Moonaan Identity and the proposed console. One language across backend, console and infra. |
| Backend | Fastify | Identity's HTTP services are Fastify. The empty service is a `/health` route plus a Lambda handler wrapper. |
| Console | Vite + React | Matches "a new React/TypeScript console using the AIF Program UI's design". The AIF design itself is later (E2-S1-T1); this is the empty shell. |
| Infra | Pulumi TypeScript | iac-hub and tenant stacks are Pulumi. The program lives in `infra/` and is applied with the same `organization/<project>/<customerName>` idea. |
| Packaging | npm workspaces | Identity uses npm. Folders are `backend/`, `console/`, `infra/` as E1-S3-T1 asks. |
| Tests | Vitest | Same runner Identity CI uses. |
| Product key | `farside` | Proposal default. Address `farside.<customer>.moonaan.com`, pending D5. |

Nothing here is copied from the client-data repo, Atlas, dashmeta, AIF, or Identity source. Patterns (tags, three-stage hub dispatch, Fastify, `workflow_dispatch` for hub) are followed from public Moonaan contracts only.
