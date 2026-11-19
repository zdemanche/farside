---
description: Run a Farside scan with the bundled CLI and summarise the workspace files it wrote
argument-hint: --cloud azure|gcp --scope <id> [--fixture]
allowed-tools: Bash(node:*), Read
---

Run the Farside CLI. Deterministic work (API calls, checks, arithmetic) stays in the CLI. You only summarise files on disk.

Default workspace: `$HOME/farside-engagements` (outside the git repo, like Atlas engagements). Override with `--workspace` in `$ARGUMENTS`.

```
node ${CLAUDE_PLUGIN_ROOT}/bin/farside.mjs scan --workspace "$HOME/farside-engagements" $ARGUMENTS
```

`$ARGUMENTS` must include `--cloud azure|gcp` and `--scope <id>`. Add `--fixture` when the user wants the synthetic estate.

After the command exits, summarise only `findings.json`, `coverage.json`, and `issues.json` from that workspace. Never state a finding the CLI did not produce.

If the command exits with a non-zero status, show its error output and stop. Do not read or summarise any workspace file: what is there is from an earlier run, not this one.

If `--fixture` was used, say plainly that the findings are synthetic and are not from a real estate.
