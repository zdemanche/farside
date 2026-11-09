# E1-S5 remaining work

The ground-truth manifest, seed **plan**, and an ARM **apply path** live in this tree. Physical Azure subscriptions do not. Nothing has been applied to a live subscription. Missing credentials skip apply with exit 0; CI never needs them.

## Done here

| Task | Issue | What landed |
|---|---|---|
| E1-S5-T1 (in-repo) | #32 | `seed.mjs --create-subscriptions` builds `Microsoft.Subscription/aliases` PUTs against `AZURE_BILLING_SCOPE`. Budget `farside-test-guard` (monthly, alert at 80% to `AZURE_BUDGET_CONTACT_EMAIL`) is the cost guard. Preflight refuses an estate in the app-registration tenant. |
| E1-S5-T2 (in-repo) | #33 | `scripts/azure-estate/seed.mjs` turns every `main` item in `docs/azure/ground-truth.json` into ordered ARM REST calls (resource groups, network, disks, snapshots, VMs + power state, vault protection, App Service, load balancers, SQL, budget) or a named manual step. |
| E1-S5-T3 | #34 | Every Azure launch check has positives and negatives, or an exception with reason and `unverified`. |
| E1-S5-T4 (in-repo) | #35 | `empty-no-budget` gets one empty resource group and nothing else. Preflight fails if it already has a budget. |

## Run it

```bash
node scripts/azure-estate/seed.mjs                          # dry run: prints every ARM call
node scripts/azure-estate/seed.mjs --apply                  # skips (exit 0) without sub id or token
node scripts/azure-estate/seed.mjs --apply --create-subscriptions   # aliases only; needs billing scope
node scripts/azure-estate/seed.mjs --apply --destroy        # deletes budget + both seed resource groups
```

Options: `--config <file>` (shape in `estate.config.example.json`), `--out <file>` writes the JSON record.

| Env | Needed for |
|---|---|
| `AZURE_ACCESS_TOKEN` or signed-in `az` | Any apply. Absent: skip, exit 0. |
| `AZURE_SUBSCRIPTION_ID` | Seed / destroy. Absent: skip, exit 0. |
| `AZURE_EMPTY_SUBSCRIPTION_ID` | Seed / destroy. |
| `AZURE_BILLING_SCOPE` | `--create-subscriptions` (MCA invoice section or EA enrollment account). |
| `AZURE_APP_REGISTRATION_TENANT_ID` | Tenant-rule preflight. |
| `AZURE_BUDGET_CONTACT_EMAIL`, `AZURE_BUDGET_AMOUNT` | Cost guard. |
| `AZURE_SEED_SSH_PUBLIC_KEY` | VM admin key. No passwords. |
| `AZURE_SQL_ADMIN_LOGIN`, `AZURE_SQL_ADMIN_OBJECT_ID`, `AZURE_SQL_ADMIN_TENANT_ID` | Entra-only SQL admin. |
| `AZURE_LOCATION` | Region (default `eastus`). |

Apply with incomplete config exits 2 and lists what is missing. An ARM failure stops at that item (exit 1); PUTs are idempotent, so re-run.

## Subscription creation

Creating a subscription needs a Moonaan billing account the workspace does not have. Order: billing owner grants `Microsoft.Subscription/aliases/write` on the invoice section → `--create-subscriptions` → transfer both subscriptions to the estate tenant (not the app-registration tenant) → set the two subscription ids → seed. Off by default (`create.enabled: false`).

## Still live (not blockers for in-repo work)

| Item | Why |
|---|---|
| Billing account and subscriptions (#32, #35) | No Moonaan Azure billing scope yet. |
| First `--apply` (#33) | Needs the subscriptions. Then the portal listing per item. |
| Manual steps | Certificates (PFX with chosen expiry), wall-clock snapshot age, LB/NAT traffic, SQL backup reading. Printed by every run. |
| Live diff | Harvest vs this manifest: E2-S3-T5 / E3-S8. |
