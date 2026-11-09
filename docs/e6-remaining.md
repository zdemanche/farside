# E6 remaining work

The GCP control spec lists every launch check from the proposal table as unverified / not-supported. The live code paths are built and tested against mocked `fetch` only. **No live run has happened.** What remains is running them on a funded project (D7).

## Done here

| Task | Issue | What landed |
|---|---|---|
| E6-S1-T5 | #193 | `docs/gcp/launch-checks.json` has one entry per proposal GCP check, with role, data source, evidence fields, undetermined causes, and `billingExportRequired` on cost checks. All `liveRunAt` are null. |
| E6-S2-T3 | #198 | `docs/gcp/ground-truth.json` seeds invented waste cases. Labels map onto `InventoryRecord.tags`; `Settings.ownerTagKey` is the owner label key; `GET /inventory/no-owner` counts `disk-parked`. Cloud Asset harvest and a live project stay leftover. |
| E6-S3-T1 | #200 | `gcp-waste-unattached-disks` and `gcp-waste-unused-external-ips` fail `disk-parked` / `addr-idle` and pass the in-use lookalikes. Savings are named ranges. |
| E6-S3-T2 | #201 | `gcp-waste-old-snapshots-and-images` fails `snap-aged` / `image-stale` and passes `snap-fresh` / `image-current` using `Settings.snapshotRetentionDays`. |
| E6-S3-T3 | #202 | `gcp-waste-idle-vm-and-disk-recommendations` fails `rec-vm-parked` / `rec-disk-idle` with Recommender evidence and savings ranges. Live Recommender harvest stays leftover. |
| E6-S3-T4 | #203 | Empty Recommender lists say none were returned and do not claim the estate is clean. Missing Recommender Viewer is unassessed. Savings are Recommender min/max ranges only. Live harvest is leftover (#202). |
| E6-S4-T1 | #205 | `gcp-resilience-sql-ha-or-backup` fails `sql-zonal` / `sql-no-backup` and passes regional instances with backups enabled. Missing `availabilityType` or `backupEnabled` is undetermined. Live Cloud SQL reads stay leftover. |
| E6-S4-T2 | #206 | `docs/gcp/support-versions.json` lists MYSQL_5_6 and GKE 1.24 with sources. The check fails `sql-stale` / `gke-stale` and passes unlisted current versions with the catalogue source and date. |
| E6-S4-T3 | #207 | `gcp-lifecycle-expiring-certs` fails `cert-expiring` and passes `cert-current` using `Settings.certExpiryFlagDays`. Missing `expireTime` is undetermined. Live Certificate Manager reads stay leftover. |
| E6-S5-T1 | #209 | `detectBillingExport` returns absent, unreadable, empty, and readable states with enablement steps, start date, and history days. Connect-screen UI is leftover (#191 / #243). |
| E6-S5-T3 | #211 | Alert analysis reports `historyDays` and stays undetermined until 14 completed days exist, including an empty first export day. Empty-first-day UI is leftover (#210 / #243). |
| E6-S6-T2 | #214 | `gcp-cost-committed-use` fails low-utilisation CUD fixtures with an unused-spend range, passes well-used rows, and says none found instead of zero use. Status stays unverified. Live BigQuery harvest is leftover (#213). |
| E6-S6-T3 | #215 | `docs/gcp/alert-replay.json` drives the same floor/burst/relative alerts with `projectId` mapped to the shared daily-cost row. Live BigQuery harvest is leftover (#213). |
| E6-S7-T1 | #217 | List APIs accept `?cloud=azure` or `?cloud=gcp` and keep per-cloud inventory. Console has a Cloud selector; Inventory, Issues, Cost and waste, Lifecycle and Recovery show a Cloud column and re-read for the chosen cloud. `CloudFilter.test.tsx` covers both clouds. |
| E6-S7-T2 | #218 | Headline emits per-cloud figures. Mixed-currency money is `byCloud` and is never summed. |
| E6-S2-T2 | #197 | Injected Cloud Asset client pages `pageToken` across every launch asset type from the ground-truth fixture. Throttle → `throttling`, other errors → `failed_call`. Default scan path stays the fixture harvester. Live Cloud Asset on a project leftover. |
| E6-S6-T1 | #213 | Injected BigQuery export client pages fixture spend rows and stores service/project aggregates. Harvest stays `unverified`. Live export and console comparison leftover. |
| E6-S7-T4 | #220 | GCP support-matrix table is linted against `launch-checks.json` (id, group, title, role, billing export, status, support, live run). Live rerun leftover. |
| E6-S1-T2 | #190 / #188 | `gcp-federation.ts`: OIDC token file (`FARSIDE_GCP_SUBJECT_TOKEN_FILE` or `AWS_WEB_IDENTITY_TOKEN_FILE`) → `sts.googleapis.com` → `iamcredentials` `generateAccessToken` for the customer service account. Read-only scope, in-memory cache until 5 min before expiry, no stored secret, errors carry step + status only. AWS-signed (`aws4_request`) subject tokens not built. |
| E6-S2-T2 / E6-S7 | #195 / #216 | `gcp-live.ts`: fetch clients for Cloud Asset (`pageToken`, RESOURCE content), Cloud SQL, GKE, Certificate Manager, Recommender, BigQuery export query and export-state detector. `gcp-live-harvester.ts`: live harvester, used only when `FARSIDE_GCP_LIVE=1` plus project, pool, provider, service account and token file are set. Default path stays the fixture harvester; CI sets nothing. |
| E6-S1-T4 | #192 | `gcp-role-verify.ts` (`npm run gcp:roles -w backend`): `testIamPermissions` per spec role, dated record `docs/gcp/live-runs/<date>-<project>-roles.json`. Also a `RoleLister` for the connect probe. |
| E6-S1-T1 / T6 / E6-S2-T1 | #189 / #194 / #196 | `scripts/gcp-estate/seed.mjs`: gcloud/bq/openssl plan from `ground-truth.json` + `live-seed.json`, budget guard, export dataset, phases `base` / `fresh`, teardown. Dry run by default; `--apply` needs credentials, `FARSIDE_GCP_SEED_PROJECT` and `FARSIDE_GCP_BILLING_ACCOUNT`. No credentials → `skipped: no GCP credentials`, exit 0. |
| E6-S7-T3 | #219 | `gcp-live-run.ts` (`npm run gcp:live -w backend`): harvests live, runs every GCP check, diffs against expected results from the manifest, writes `docs/gcp/live-runs/<date>-<project>-checks.json` with `liveRunAt`, marks passing checks verified in `launch-checks.json` and regenerates the matrix. `scripts/support-matrix/generate.mjs` reads `live-runs/`. |

## Leftovers

### Live run (D7)

Only the live run remains. In order: fund the project and pool (#189); `seed.mjs --apply --phase=base`; switch on the BigQuery export in the console, which has no API (#194); wait past `snapshotRetentionDays` and for Recommender idle days; `--phase=fresh`; `gcp:roles` (#192); `gcp:live` (#219); compare BigQuery spend with the console by hand (#213); `--teardown`. Connect screen UI stays #191 / #243. Do not copy AIF client names.

Known before any live run:

- Recommender returns a point cost, not a range. Live idle findings stay undetermined until the savings rule is decided, so that check will diff as fail.
- GKE reads need `container.clusters.list`, which no spec role grants. The role record lists it as unnamed.
- `gke-stale` (GKE 1.24) cannot be created; `sql-stale` (MYSQL_5_6) may be refused. Both are flagged in `live-seed.json`.
- Committed-use: no live reader and the seed buys no commitment. Spend-by-service needs a console comparison. Both record `not-run`.
- Internal reserved addresses would be judged like external ones.
