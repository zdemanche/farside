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
2. `/farside:scan --cloud azure --scope <subscription-id> --fixture` — runs the bundled CLI against the synthetic estate. Drop `--fixture` only when live harvest exists (#59 / #197).
3. `/farside:findings` — explains issues from workspace files. Cite issue ids. Never state a finding the CLI did not produce.
4. `/farside:report` — writes `report.html` from the workspace export (headline, issues by category, savings ranges, blind spots, coverage, undetermined).

Equivalent CLI:

```bash
npm run farside -w @farside/backend -- connect --cloud azure --fixture
npm run farside -w @farside/backend -- scan --cloud azure --scope main --fixture
npm run farside -w @farside/backend -- findings
npm run farside -w @farside/backend -- report
```

## What stays in the CLI

Deterministic work (API calls, checks, arithmetic) runs in the CLI. Claude only interprets workspace files.
