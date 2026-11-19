---
description: Print workspace findings from the CLI, then explain them by citing issue ids
argument-hint: [--workspace <dir>]
allowed-tools: Bash(node:*), Read
---

Run the Farside CLI, then follow the findings-method skill. Do not re-run checks or invent findings.

Default workspace: `$HOME/farside-engagements` (outside the git repo, like Atlas engagements). Override with `--workspace` in `$ARGUMENTS`.

```
node ${CLAUDE_PLUGIN_ROOT}/bin/farside.mjs findings --workspace "$HOME/farside-engagements" $ARGUMENTS
```

Read `issues.json`, `findings.json`, and `coverage.json` in that workspace. Cite every claim with the issue id. Keep savings as ranges. Treat `undetermined` as a result and say the closer. Never state a finding the CLI did not produce.

If the command exits with a non-zero status, show its error output and stop. Do not read or summarise any workspace file: what is there is from an earlier run, not this one.
