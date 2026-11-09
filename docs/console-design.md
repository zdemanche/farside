# Console design system

The console looks like the rest of Moonaan because it uses the same tokens, vendored the same way `Moonaan/moonaan-identity` vendors them. There is no package dependency: CI cannot read the `@moonaan` GitHub Packages scope. Decision recorded in `docs/decisions.md` (#243).

## Layers

| File | Layer | Origin |
|---|---|---|
| `console/src/styles/evergreen-theme.css` | 0: Evergreen v0.5.0 palette, radii, motion. `moonaan` (dark, default) and `daylight` (light). | `moonaan-identity` `ui/packages/tokens/evergreen-theme.css`, unchanged |
| `console/src/styles/tokens.css` | 1 and 2: Prism derived set and Reflow semantic `--color-*`, `--space-*`, `--text-*`, `--radius-*`, focus-visible rule | `moonaan-identity` `ui/packages/tokens/tokens.css`, unchanged |
| `console/public/theme-guard.js` | Sets `data-theme` on `<html>` before first paint | `moonaan-identity` copy of Reflow's guard, unchanged |
| `console/src/styles/console.css` | Farside components: shell, tables, forms, chips, notices | Written here, `var(--*)` only |
| `console/src/styles/index.css` | Imports the three CSS files in order | Written here |

Only the first comment line of the two vendored CSS files differs from Identity's copies (it names the provenance).

## Theme

`data-theme` on `<html>` is `moonaan` or `daylight`. `index.html` ships `moonaan` for no-JS, then `theme-guard.js` replaces it from `localStorage` key `reflow-theme`. The key is the same one Identity and Reflow use; the choice is shared only when the products are served from the same origin. Settings, Appearance changes the attribute and writes the key (storage failures are swallowed; the choice then lasts for the page view).

## Rules

- No raw colour, `px`/`rem` length, or `ms`/`s` duration in `console.css` or any `.tsx`; use `var(--*)`. No inline `style`. Media query breakpoints are the one exception because `var()` is not allowed there; they use `em`.
- Status colour never carries meaning alone: a chip always has its text (`succeeded`, `unassessed`, ...).
- Do not redefine `:focus-visible`; `tokens.css` owns it.
- `console/src/styles/tokens.test.ts` enforces the rules above, pins the sha256 of the three vendored files, and checks theme parity.

## Data source and screen states

Every screen reads from one `DataSource` (`console/src/data/`), passed down by React context. No screen has a fixture default.

| Build env | Source |
|---|---|
| `VITE_FARSIDE_DEMO=1` | `demoSource()`: one seeded estate; every screen's numbers are derived from its rows. Only this mode shows the Demo label. |
| `VITE_FARSIDE_API_URL` and `VITE_FARSIDE_ORG` | `apiSource()`: `fetch` against `/v1/orgs/:orgId/...` with the `x-farside-org` header. |
| `VITE_FARSIDE_API_URL`, `VITE_FARSIDE_IDENTITY_ISSUER` and `VITE_FARSIDE_IDENTITY_CLIENT_ID` (demo off) | Sign-in first (see below), then `apiSource()` with `authorization: Bearer` and no `x-farside-org` header. |
| neither | "Not connected to a Farside API". No data is shown. |

Fixtures are imported only by `data/demo.ts` and tests. Recovery and Lifecycle have no backend route of their own; both are derived from `GET /findings`.

`useResource` gives `loading | error | ready`, and `<ScreenState>` renders each: `role="status"` while loading, `role="alert"` with Retry on failure, an explanatory empty message, a "Partial: N scopes not assessed" notice on screens that list assessed-scope results, and distinct messages for not signed in (401), no access to the organisation (403) and a deleted organisation (410), none of which offer Retry. The demo source is a separate chunk, loaded only in demo mode. The overview is fetched once and shared, so a never-scanned org reads "Not checked yet" instead of "no gaps".

## Sign-in and org claim (#46, #49)

When the identity env vars are set (and demo mode is off), the shell shows **Sign in** in place of the navigation until the user is signed in and belongs to the org, then **Claim your organisation** (nobody has claimed it: the user becomes owner) or **Join your organisation** (claimed: the user becomes a member). Both keep the skip link, the `main` landmark, the `page-title` heading and the document title; after a step the user takes (claim, join, sign out) focus moves to the new heading. `console/e2e/identity.spec.ts` runs axe (contrast included) in both themes, the no-sideways-scroll check and the full PKCE flow against a second build with stubbed provider and API.

Sign-in is the OIDC authorization code flow with PKCE (S256), in `data/identity.ts` and `data/use-identity.ts`:

| Env | Meaning | Default |
|---|---|---|
| `VITE_FARSIDE_IDENTITY_ISSUER` | OIDC issuer; endpoints come from its discovery document | required |
| `VITE_FARSIDE_IDENTITY_CLIENT_ID` | Public client id registered for the console | required |
| `VITE_FARSIDE_IDENTITY_ORG_CLAIM` | Token claim naming the org; falls back to `VITE_FARSIDE_ORG` | none |
| `VITE_FARSIDE_IDENTITY_REDIRECT_URI` | Redirect URI registered for the client | console origin + path |
| `VITE_FARSIDE_IDENTITY_SCOPE` | Scopes requested | `openid profile email` |
| `VITE_FARSIDE_IDENTITY_AUDIENCE` | Sent as `audience` when the provider needs it | not sent |
| `VITE_FARSIDE_IDENTITY_AUTHORIZE_URL`, `VITE_FARSIDE_IDENTITY_TOKEN_URL` | Skip discovery when both are set | discovery |
| `VITE_FARSIDE_IDENTITY_NAME` | Provider name on the button | `Moonaan Identity` |

The access token (or the ID token if the provider returns no access token) is kept in `sessionStorage` (memory if storage is blocked), never `localStorage`, and is dropped at `exp` or on Sign out. Sign out is local; provider logout is not wired. None of these values describe Moonaan Identity's real tenant: set them when the tenant exists (see `docs/e2-remaining.md`).

The AIF Program UI design could not be read from this workspace, so these screens use the Farside shell and tokens. Parity with AIF navigation and its accessibility tests (#47) is a later review; nothing was copied from AIF.

## Upgrading the vendored files

1. Copy the newer files from `moonaan-identity` (`ui/packages/tokens/`) over `evergreen-theme.css`, `tokens.css` and `theme-guard.js`; keep the Farside provenance comment as the first line of the two CSS files.
2. Run `shasum -a 256` on each and update `VENDORED_SHA256` in `tokens.test.ts`.
3. Run `npm test` and `npm run build`.

When CI can read the registry, replace the two CSS files with `@import '@moonaan/evergreen-design-system/theme.css'` and drop the hash pins.
