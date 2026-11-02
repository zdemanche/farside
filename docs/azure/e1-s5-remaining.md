# E1-S5 remaining work

The ground-truth manifest and seed **plan** live in this tree. Physical Azure subscriptions do not. Missing `AZURE_SUBSCRIPTION_ID` skips apply; it must not fail the required CI check.

## Done here

| Task | Issue | What landed |
|---|---|---|
| E1-S5-T2 (in-repo) | #33 | Repeatable seed plan in `docs/azure/ground-truth.json` (`items`). `scripts/azure-estate/seed.mjs` skips ARM apply. |
| E1-S5-T3 | #34 | Every Azure launch check has positives and negatives, or an exception with reason and `unverified`. |

## Still physical (not blockers for in-repo work)

### Subscriptions and cost guard (#32)

Needs a Moonaan-owned tenant **other than** the app-registration tenant, a budget with an alert on the main sub, and Farside reader roles assignable. Decision D3 is adopted; the subscriptions are not created.

### Apply the seed (#33 leftover)

Portal listing of each seeded item needs that subscription. Snapshot age and stopped-but-allocated power state are wall-clock / runtime after create.

### Empty second subscription (#35)

`empty-no-budget` is declared in the manifest. Creating it in Azure is live.

### Live diff

Comparing harvest to this manifest is E2-S3-T5 / E3-S8 once a subscription exists.
