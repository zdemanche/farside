# GCP support matrix (template)

**Rule:** an entry is unverified until a dated live run exists. Unverified entries are labelled **not supported**. Filling `liveRunAt` needs D7 and a GCP test project.

Roles and API names come from the proposal table. They have not been run live. Cost checks require the BigQuery billing export.

| Check id | Group | Title | Role | Billing export | Status | Support | Live run |
|---|---|---|---|---|---|---|---|
| gcp-inventory-all-assets | inventory | All assets by project and type | Cloud Asset Viewer | no | unverified | not-supported | — |
| gcp-inventory-no-owner-label | inventory | Resources with no owner label | Cloud Asset Viewer | no | unverified | not-supported | — |
| gcp-waste-unattached-disks | waste | Unattached disks | Compute Viewer | no | unverified | not-supported | — |
| gcp-waste-unused-external-ips | waste | Reserved but unused external IPs | Compute Viewer | no | unverified | not-supported | — |
| gcp-waste-old-snapshots-and-images | waste | Old snapshots and images | Compute Viewer | no | unverified | not-supported | — |
| gcp-waste-idle-vm-and-disk-recommendations | waste | Idle VM and disk recommendations | Recommender Viewer | no | unverified | not-supported | — |
| gcp-cost-spend-by-service | cost | Spend by service and project | BigQuery access to the billing export | yes | unverified | not-supported | — |
| gcp-cost-committed-use | cost | Committed-use discount use | BigQuery access to the billing export | yes | unverified | not-supported | — |
| gcp-resilience-sql-ha-or-backup | resilience | Cloud SQL without high availability or backups | Cloud SQL Viewer | no | unverified | not-supported | — |
| gcp-lifecycle-sql-gke-support | lifecycle | Out-of-support SQL and GKE versions | Cloud SQL Viewer | no | unverified | not-supported | — |
| gcp-lifecycle-expiring-certs | lifecycle | Expiring certificates | Certificate Manager Viewer | no | unverified | not-supported | — |

Source of rows: [`launch-checks.json`](launch-checks.json). The lint in `scripts/gcp-spec/lint.mjs` fails if a proposal GCP check is missing, if a required field is missing, if a cost check omits the billing-export dependency, or if a matrix row disagrees with the spec on id, group, title, role, billing export, status, support, or live run.

Run records: `scripts/support-matrix/generate.mjs` reads `live-runs/*.json` written by `npm run gcp:live -w backend`. None exist yet.
