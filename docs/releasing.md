# Releasing

Farside is one product in one repo. One version, one `CHANGELOG.md`, one GitHub Release, one `v*` tag.

## How a release happens

1. Commits that land on `main` use [Conventional Commits](https://www.conventionalcommits.org/).
2. On every push to `main`, [release-please](https://github.com/googleapis/release-please) opens or updates a release pull request. That PR bumps the root `package.json` version, writes `CHANGELOG.md`, and lists the commits since the last tag.
3. A human (Zach) merges the release PR when ready. Do not merge it from automation.
4. Merging the release PR creates the GitHub Release and the `vX.Y.Z` tag.

The first release is **0.1.0**. The manifest starts at `0.0.0` so the first conventional `feat:` on `main` opens the 0.1.0 release PR.

## Commit convention

```
<type>(optional-scope): <description>
```

| Prefix | SemVer bump | Use for |
|---|---|---|
| `feat:` | minor (`0.1.0` → `0.2.0`) | A user-visible capability |
| `fix:` | patch (`0.1.0` → `0.1.1`) | A bug fix |
| `perf:` | patch | A performance fix |
| `feat!:` / `fix!:` / `BREAKING CHANGE:` in the footer | major (`0.x` still majors unless we later set `bump-minor-pre-major`) | A breaking change |
| `docs:` `chore:` `refactor:` `test:` `ci:` `build:` `style:` | none (listed in the changelog when configured) | No version bump |

Examples:

```
feat: add GCP snapshot waste checks
fix: keep cost harvest when a resource scan runs
docs: record the GHCR image decision
```

Dependabot and audit titles that are not conventional do not bump the version. Prefer the prefixes above on new work so the next release PR is accurate.

## Workflow permissions

`.github/workflows/release.yml` uses `GITHUB_TOKEN` with `contents: write` and `pull-requests: write` only. No packages, id-token, or issues scopes.

The repository must allow GitHub Actions to create pull requests (Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests").

A `GITHUB_TOKEN`-created tag or Release does not start other workflows. A PAT on the release workflow is leftover if we later want CI to run on the release PR itself, or want a tag to trigger a separate publish workflow. Until then, a publish job can run in the same workflow as release-please, or a human can dispatch it.

## Follow-ups

| What | When |
|---|---|
| Container images to GHCR (`ghcr.io/zdemanche/farside-api`, `farside-console`) | Next (PR B). Not in this change. |
| GitHub Pages demo-mode console | After the console design pass ([#243](https://github.com/zdemanche/farside/issues/243) dependents) lands. Do not start it now. |
