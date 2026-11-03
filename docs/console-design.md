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

## Upgrading the vendored files

1. Copy the newer files from `moonaan-identity` (`ui/packages/tokens/`) over `evergreen-theme.css`, `tokens.css` and `theme-guard.js`; keep the Farside provenance comment as the first line of the two CSS files.
2. Run `shasum -a 256` on each and update `VENDORED_SHA256` in `tokens.test.ts`.
3. Run `npm test` and `npm run build`.

When CI can read the registry, replace the two CSS files with `@import '@moonaan/evergreen-design-system/theme.css'` and drop the hash pins.
