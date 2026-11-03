# E6 remaining work

The GCP control spec lists every launch check from the proposal table as unverified / not-supported. A live project (D7), federated connect, Cloud Asset harvest, and Recommender proof stay leftover.

## Done here

| Task | Issue | What landed |
|---|---|---|
| E6-S1-T5 | #193 | `docs/gcp/launch-checks.json` has one entry per proposal GCP check, with role, data source, evidence fields, undetermined causes, and `billingExportRequired` on cost checks. All `liveRunAt` are null. |
| E6-S2-T3 | #198 | `docs/gcp/ground-truth.json` seeds invented waste cases. Labels map onto `InventoryRecord.tags`; `Settings.ownerTagKey` is the owner label key; `GET /inventory/no-owner` counts `disk-parked`. Cloud Asset harvest and a live project stay leftover. |
| E6-S3-T1 | #200 | `gcp-waste-unattached-disks` and `gcp-waste-unused-external-ips` fail `disk-parked` / `addr-idle` and pass the in-use lookalikes. Savings are named ranges. Recommender idle findings stay leftover (#202). |

## Leftovers

### Live GCP project, Identity, AIF collectors

A funded project (#189), federated credentials (#190), Connect screen (#191 / #243), live role proof (#192), and billing export enablement (#194) need D7. Cloud Asset harvest (#197) is also (d) AIF. Do not copy AIF client names.
