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

This command exits non-zero when credentials or required roles are missing, and in that case it has still written `connect.json` for this run and printed the same JSON report on stdout. Use that report, read `connect.json`, and name the missing roles as above. If the command printed no JSON report on stdout (a usage error or a crash), stop and show the error output: any `connect.json` in the workspace is then from an earlier run.
