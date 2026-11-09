# Plugin release checklist (E7, #346 #360 #362 #404)

Two gates: Zach's local test sign-off (#404), then the Moonaan marketplace entry (#360 / #362). **Neither has happened.** Text only; the marketplace PR is not opened from this repo.

## Gate 1: local test sign-off (#404)

Run in your own Claude Code on a clean machine or a fresh user profile. Record results in #404.

### Install

- [ ] `git clone` this repo (or use the GitHub source); no `npm ci` needed for the plugin path.
- [ ] `/plugin marketplace add <checkout-path>` (or `zdemanche/farside`), then `/plugin install farside@farside`.
- [ ] `/plugin` lists `farside` at the version in `plugin/.claude-plugin/plugin.json`; marketplace entry version matches (`npm run lint:plugin` enforces this).
- [ ] Alternative: `claude --plugin-dir <checkout>/plugin` loads the same commands.

### Commands and skill (fixture data)

Use a throwaway workspace: add `--workspace /tmp/farside-signoff` to each.

- [ ] `/farside:connect --cloud azure --fixture` → `connect.json`, no missing roles.
- [ ] `/farside:connect --cloud gcp` without ADC → names missing credentials and expected roles; exit is non-zero; nothing secret written.
- [ ] `/farside:scan --cloud azure --scope main --fixture` → `scanId: scan-1`, findings include the unattached disk.
- [ ] `/farside:scan --cloud gcp --scope farside-test --fixture` into the **same** workspace → `scanId: scan-2`; `findings.json` still has the Azure rows (fixed in this repo; was the known rough edge).
- [ ] `/farside:findings` → cites issue ids only from `issues.json`; no invented finding.
- [ ] `/farside:report` → `report.html` opens; headline, issues by category, savings as ranges, blind spots, coverage, undetermined.
- [ ] Skill `findings-method` loads when asking "explain these findings" and follows evidence-first rules.
- [ ] A token flag (`--token x`, `--client-secret x`) is refused with the token message.

### Clean-install CLI

- [ ] With no checkout `node_modules`, `node plugin/bin/farside.mjs --help` runs the shipped `plugin/bin/farside-cli.mjs`.
- [ ] `npm run lint:plugin` passes on the commit being signed off (bundle current).
- [ ] Node version on the test machine: ____ (needs 22+).

### Sign-off

- [ ] Rough edges filed as follow-up issues (list numbers here): ______
- [ ] Zach comments "signed off at <sha>" on #404.

## Gate 2: Moonaan marketplace entry (#360 / #362)

Prerequisites, in order:

1. [ ] #404 signed off.
2. [ ] Org transfer done (`docs/org-transfer-checklist.md`); installs then use Moonaan org GitHub auth.
3. [ ] A release tag `vX.Y.Z` exists that contains the signed-off commit.

### Entry text for `Moonaan/moonaan-marketplace`

Add to that repo's `.claude-plugin/marketplace.json` `plugins` array (copy fields from this repo's `plugins[0]`; only `source` changes):

```json
{
  "name": "farside",
  "source": { "source": "github", "repo": "Moonaan/moonaan-farside", "path": "plugin" },
  "description": "Azure and GCP infrastructure scanning, issues, and cost. Same checks as the Farside product, run locally.",
  "version": "<X.Y.Z from the release>",
  "author": { "name": "Moonaan, LLC" },
  "category": "infrastructure"
}
```

If that marketplace's schema pins a ref, add `"ref": "vX.Y.Z"` and bump it per release.

### PR description (paste)

> Adds the Farside plugin (Azure and GCP infrastructure scanning; read-only; local workspace). Source `Moonaan/moonaan-farside/plugin` at `vX.Y.Z`. Local test sign-off: farside#404. Same product version as the Farside release; release-please bumps `plugin.json` and the repo marketplace entry.

### Release automation (already in this repo)

- [ ] release-please bumps `plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` versions with the product.
- [ ] `plugin-maintain.yml` rebuilds `plugin/bin/farside-cli.mjs` on every push to `main` and opens a PR if it changed.
- [ ] Remaining for #362: a step (here or in the marketplace repo) that bumps the Moonaan marketplace entry's `version`/`ref` when a release is published. Mirror Atlas's auto-maintain workflow once that repo is readable; not written here because its format is unread.

### After merge

- [ ] `/plugin install farside@moonaan-marketplace` works on a machine with Moonaan org access.
- [ ] `docs/plugin.md` drops "leftover" from the marketplace paragraph.
- [ ] Close #362, then #360.
