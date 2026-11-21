# Claude Code plugin

Farside ships a Claude Code plugin from `plugin/` in this repo. Same product version as the CLI (`docs/releasing.md`).

## Install

This repo is a Claude Code marketplace (`.claude-plugin/marketplace.json`, one entry: `farside` at `./plugin`). Install from a checkout or from GitHub:

```
/plugin marketplace add <repo-path-or-zdemanche/farside>
/plugin install farside@farside
```

Or load without installing: `claude --plugin-dir <repo>/plugin`.

After D5, install from the Moonaan marketplace:

```
/plugin install farside@moonaan-marketplace
```

That marketplace entry is leftover: it is a PR to `Moonaan/moonaan-marketplace` ([#362](https://github.com/zdemanche/farside/issues/362)) and has not been made. Do not treat it as available yet. The entry text, PR description and the local test sign-off (#404) that must come first are in `docs/plugin-release-checklist.md`.

## Release automation

- release-please bumps `version` in `plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` with the product version. `npm run lint:plugin` fails if either drifts.
- `.github/workflows/plugin-maintain.yml` runs on every push to `main`: it rebuilds the bundled CLI and opens a `chore/plugin-cli-bundle` PR if the bytes changed. Set the optional `PLUGIN_MAINTAIN_TOKEN` secret so that PR starts CI.

## The bundled CLI

The plugin runs `plugin/bin/farside-cli.mjs`, a single-file build of `backend/src/cli.ts` that is committed in `plugin/`. An install of the plugin alone, with no checkout, can therefore scan. The version in `plugin/.claude-plugin/plugin.json` is bumped by release-please (`docs/releasing.md`).

After changing anything the CLI imports, run `npm run plugin:bundle` and commit the result. `npm run lint` fails with "plugin CLI bundle is out of date" if you forget, so a PR cannot merge a plugin that runs stale checks.

## First scan

Workspace files default to `~/farside-engagements` (outside the git repo, like Atlas engagements). Override with `--workspace`. `state.json` keeps scan history, per-cloud inventory and cost, so scanning a second cloud into the same workspace keeps the first cloud's findings and issues, and scan ids keep counting (`scan-1`, `scan-2`, ...). A rescan of the same cloud and scope replaces only that scope's rows.

1. `/farside:connect --cloud azure` (or `gcp`) — probes local credentials and names missing roles.
2. `/farside:scan --cloud azure --scope <subscription-id> --fixture` — runs the bundled CLI against the synthetic estate. Drop `--fixture` and set the live variables below to scan a real cloud.
3. `/farside:findings` — explains issues from workspace files. Cite issue ids. Never state a finding the CLI did not produce.
4. `/farside:report` — writes `report.html` from the workspace export (headline, issues by category, savings ranges, blind spots, coverage, undetermined).

Equivalent CLI:

```bash
npm run farside -w @farside/backend -- connect --cloud azure --fixture
npm run farside -w @farside/backend -- scan --cloud azure --scope main --fixture
npm run farside -w @farside/backend -- findings
npm run farside -w @farside/backend -- report
```

## Live scanning (opt-in)

Without any of these variables the CLI behaves exactly as above: `--fixture` scans the synthetic estate, and a scan without it fails because no live harvest is configured. Setting a cloud's switch makes `scan` read the real cloud through federated credentials, the same way the backend does. No client secret or key is accepted. The local sign-in probe is skipped when a switch is on, because the credentials come from the environment.

| Cloud | Variables | Notes |
|---|---|---|
| Azure | `FARSIDE_AZURE_LIVE=1`, `FARSIDE_AZURE_CLIENT_ID`, `FARSIDE_AZURE_TENANT_ID`, and `AWS_WEB_IDENTITY_TOKEN_FILE` (or `FARSIDE_AZURE_ASSERTION_FILE`) | `--scope` is the subscription id. The scan lists the roles the identity holds on it and names any missing ones on stderr. |
| GCP | `FARSIDE_GCP_LIVE=1`, `FARSIDE_GCP_PROJECT_ID`, `FARSIDE_GCP_POOL_PROJECT_NUMBER`, `FARSIDE_GCP_POOL_ID`, `FARSIDE_GCP_PROVIDER_ID`, `FARSIDE_GCP_SERVICE_ACCOUNT`, and `FARSIDE_GCP_SUBJECT_TOKEN_FILE` (or `AWS_WEB_IDENTITY_TOKEN_FILE`) | `--scope` must be the configured project; any other scope is refused before a network call. |

When a live read fails, stderr names the error and its causes with their status, code and federation step (for example `FederatedExchangeError` with `AADSTS70021`, or `GcpFederationError` at step `sts`), and never a token, URL or response body. A failed scan exits 1 and writes nothing to the workspace, so earlier results are left as they were. That holds for a refused Azure token, a failed Resource Graph read, and a failed GCP Cloud Asset read.

What a successful live GCP scan saves is limited to what was really assessed:

- The committed-use check is not saved. Its registered implementation reads fixture commitments for any project, so on a real project it would report fabricated findings. It is recorded as unassessed, with the closer "Enable the BigQuery billing export".
- A read the harvest could not make, such as the Recommender when Recommender Viewer is not granted, is recorded as unassessed with its cause, never as "assessed, nothing found". The coverage counts printed on stdout come from this adjusted coverage.
- Cloud SQL, GKE and Certificate Manager reads that fail are still skipped silently by the harvester (a known gap in the backend), so those checks can read as assessed on an empty read.

A live scan and a fixture scan never share a workspace. Live scans are marked `source: "live"` in `state.json`. A live scan into a workspace that holds fixture scans, and a fixture scan into one that holds live scans, are refused with a message to use a new `--workspace`, and the workspace is left untouched. A workspace that never held a live scan behaves exactly as before.

`connect` is not live-aware: it probes a local sign-in and reports roles as unverified. Skip it for live use. An Azure scan lists the roles itself, and `FARSIDE_GCP_BILLING_EXPORT_TABLE` is not used by the CLI scan.

Built and tested against mocked clouds only. The first run against a real subscription or project is the live-verification step in the go-live issues (#413, #414).

## What stays in the CLI

Deterministic work (API calls, checks, arithmetic) runs in the CLI. Claude only interprets workspace files.
