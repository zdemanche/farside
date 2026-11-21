---
description: Write an HTML consultant report from workspace export rows
argument-hint: [--workspace <dir>]
allowed-tools: Bash(node:*), Read
---

Run the Farside CLI. Deterministic work (headline, savings, HTML) stays in the CLI. You only confirm the file it wrote.

Default workspace: `$HOME/farside-engagements` (outside the git repo, like Atlas engagements). Override with `--workspace` in `$ARGUMENTS`.

```
node ${CLAUDE_PLUGIN_ROOT}/bin/farside.mjs report --workspace "$HOME/farside-engagements" $ARGUMENTS
```

After the command exits, open `report.html` in that workspace. Cite issue ids from the report. Never state a figure or issue the CLI did not write.

If the command exits with a non-zero status, show its error output and stop. Do not read or summarise any workspace file: what is there is from an earlier run, not this one.
