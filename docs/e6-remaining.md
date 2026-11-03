# E6 remaining work

The GCP control spec lists every launch check from the proposal table as unverified / not-supported. A live project (D7), federated connect, Cloud Asset harvest, and Recommender proof stay leftover.

## Done here

| Task | Issue | What landed |
|---|---|---|
| E6-S1-T5 | #193 | `docs/gcp/launch-checks.json` has one entry per proposal GCP check, with role, data source, evidence fields, undetermined causes, and `billingExportRequired` on cost checks. All `liveRunAt` are null. |

## Leftovers

### Live GCP project, Identity, AIF collectors

A funded project (#189), federated credentials (#190), Connect screen (#191 / #243), live role proof (#192), and billing export enablement (#194) need D7. Cloud Asset harvest (#197) is also (d) AIF. Do not copy AIF client names.
