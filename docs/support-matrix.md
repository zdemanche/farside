# Regenerating the support matrices

`docs/azure/support-matrix.md` and `docs/gcp/support-matrix.md` are generated from each cloud's `launch-checks.json` plus its run records. Run `npm run lint:support-matrix` to check them, or `node scripts/support-matrix/generate.mjs --write` to rewrite the tables.

A check is **verified** only when a dated passing run record exists. With no record it stays `unverified` and `not-supported`. A failing record never verifies a check.

## Run record format (Farside-local)

One file per live run at `docs/<cloud>/run-records/<name>.json`:

```json
{ "checkId": "azure-waste-unattached-disks", "liveRunAt": "2026-12-01", "result": "pass" }
```

The latest passing record for a check wins. After adding a record, set that check's `status`, `support` and `liveRunAt` in `launch-checks.json` to match; the check fails until the spec and the records agree. Azure matrix notes (the last column) are hand-written and are kept when the table is regenerated.

No live runs have happened, so there are no run records yet.
