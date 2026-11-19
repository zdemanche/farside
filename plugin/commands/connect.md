---
description: Check local Azure or GCP credentials and name missing roles and the checks they block
argument-hint: --cloud azure|gcp [--fixture]
allowed-tools: Bash(node:*), Read
---

Run the Farside CLI. Do not list cloud roles, invent grants, or harvest yourself.

Default workspace: `$HOME/farside-engagements` (outside the git repo, like Atlas engagements). Override with `--workspace` in `$ARGUMENTS`.

```
node ${CLAUDE_PLUGIN_ROOT}/bin/farside.mjs connect --cloud azure --workspace "$HOME/farside-engagements" $ARGUMENTS
```

Read `connect.json` in that workspace. Name every `missingRoles` entry and the `blockedCheckIds` it blocks. If `roleListing` is `unverified`, say the `closer` and list `expectedRoles` — do not claim those roles are granted.

If the command exits with a non-zero status, show its error output and stop. Do not read or summarise any workspace file: what is there is from an earlier run, not this one.
