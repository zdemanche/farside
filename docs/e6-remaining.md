# E6 remaining work

The GCP control spec lists every launch check from the proposal table as unverified / not-supported. A live project (D7), federated connect, Cloud Asset harvest, and Recommender proof stay leftover.

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
| E6-S7-T1 | #217 | List APIs accept `?cloud=azure` or `?cloud=gcp` and keep per-cloud inventory. Console labels/filters and the two-cloud e2e stay leftover. |
| E6-S7-T2 | #218 | Headline emits per-cloud figures. Mixed-currency money is `byCloud` and is never summed. |

## Leftovers

### Live GCP project, Identity, AIF collectors

A funded project (#189), federated credentials (#190), Connect screen (#191 / #243), live role proof (#192), and billing export enablement (#194) need D7. Cloud Asset harvest (#197) is also (d) AIF. Do not copy AIF client names.
