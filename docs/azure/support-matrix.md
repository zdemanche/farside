# Azure support matrix (template)

**Rule:** an entry is unverified until a dated live run exists. Unverified entries are labelled **not supported**. Filling `liveRunAt` from a real subscription is [E1-S7](https://github.com/zdemanche/farside/issues/40).

Roles and API names come from general Azure knowledge (`docs/proposal.md`). They have not been run live.

| Check id | Group | Title | Role | Status | Support | Live run | Notes |
|---|---|---|---|---|---|---|---|
| azure-inventory-all-resources | inventory | All resources by subscription, type, and region | Reader | unverified | not-supported | — | |
| azure-inventory-no-owner-tag | inventory | Resources with no owner tag | Reader | unverified | not-supported | — | |
| azure-waste-unattached-disks | waste | Unattached disks | Reader | unverified | not-supported | — | |
| azure-waste-unassociated-public-ips | waste | Unassociated public IPs | Reader | unverified | not-supported | — | |
| azure-waste-old-snapshots | waste | Old snapshots | Reader | unverified | not-supported | — | |
| azure-waste-stopped-not-deallocated-vms | waste | VMs stopped but not deallocated | Reader | unverified | not-supported | — | |
| azure-waste-empty-app-service-plans | waste | Empty App Service plans | Reader | unverified | not-supported | — | |
| azure-waste-idle-load-balancers | waste | Idle load balancers | Reader | unverified | not-supported | — | |
| azure-waste-idle-nat-gateways | waste | Idle NAT gateways | Reader | unverified | not-supported | — | |
| azure-cost-spend-by-service | cost | Spend by service | Cost Management Reader | unverified | not-supported | — | Billing scope/currency vary by agreement |
| azure-cost-month-on-month | cost | Month-on-month spend change | Cost Management Reader | unverified | not-supported | — | |
| azure-cost-reservation-use | cost | Reservation use | Reservations Reader | unverified | not-supported | — | |
| azure-cost-savings-plan-use | cost | Savings plan use | Reservations Reader | unverified | not-supported | — | |
| azure-cost-subscriptions-without-budgets | cost | Subscriptions without budgets | Cost Management Reader | unverified | not-supported | — | Second empty subscription is E1-S5 |
| azure-resilience-prod-vms-outside-backup | resilience | Production VMs outside Azure Backup | Backup Reader | unverified | not-supported | — | |
| azure-resilience-prod-sql-outside-backup | resilience | Production SQL outside Azure Backup | Backup Reader | unverified | not-supported | — | |
| azure-resilience-db-zone-or-geo | resilience | Databases without zone redundancy or geo-backup | Reader | unverified | not-supported | — | |
| azure-lifecycle-retiring-skus | lifecycle | Retiring SKUs | Reader | unverified | not-supported | — | |
| azure-lifecycle-expiring-app-service-certs | lifecycle | Expiring App Service certificates | Reader | unverified | not-supported | — | |
| azure-lifecycle-expiring-gateway-certs | lifecycle | Expiring gateway certificates | Reader | unverified | not-supported | — | |

Source of rows: [`launch-checks.json`](launch-checks.json). The lint in `scripts/azure-spec/lint.mjs` fails if a launch check is missing, if a required field is missing, or if `status` is missing.
