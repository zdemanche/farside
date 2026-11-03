# Claude Code plugin

Farside ships a Claude Code plugin from `plugin/` in this repo. Same product version as the CLI (`docs/releasing.md`).

## Install

Until the org transfer (D5) and marketplace listing (#362) land, load the plugin from a checkout:

```bash
claude --plugin-dir <repo>/plugin
```

After D5, install from the Moonaan marketplace:

```
/plugin install farside@moonaan-marketplace
```

That marketplace entry is leftover. Do not treat it as available yet.

## First scan

Workspace files default to `~/farside-engagements` (outside the git repo, like Atlas engagements). Override with `--workspace`.

1. `/farside:connect --cloud azure` (or `gcp`) — probes local credentials and names missing roles.
2. `/farside:scan --cloud azure --scope <subscription-id> --fixture` — runs the bundled CLI against the synthetic estate. Drop `--fixture` only when live harvest exists (#59 / #197).
3. `/farside:findings` — explains issues from workspace files. Cite issue ids. Never state a finding the CLI did not produce.

Equivalent CLI:

```bash
npm run farside -w @farside/backend -- connect --cloud azure --fixture
npm run farside -w @farside/backend -- scan --cloud azure --scope main --fixture
npm run farside -w @farside/backend -- findings
```

`/farside:report` is leftover until E7-S3.

## What stays in the CLI

Deterministic work (API calls, checks, arithmetic) runs in the CLI. Claude only interprets workspace files.
