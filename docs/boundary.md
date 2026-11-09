# Farside boundary with dashmeta and Atlas

**Status:** D1 adopted per owner direction, Nov 2 2026. This is the working boundary, not a personal sign-off from Ryan Morris or Kevin.

| Field | Value |
|---|---|
| Prepared from | `docs/proposal.md` (revised 2026-11-01), live Jira summaries on 2026-11-02, owner direction 2026-11-02 |
| Decision | [D1](https://github.com/zdemanche/farside/issues/1) recorded in `docs/decisions.md` |
| Ryan Morris agreement | _not a personal comment_ — E1-S1-T4 (#14) is satisfied by owner direction |
| Kevin agreement | _not a personal comment_ — same |
| D1 closed | yes, by recording the recommendation |
| Tickets changed | none in dashmeta or AIF — lists only until E1-S1-T5 (#15). Paste-ready text: `docs/boundary-dashmeta-amendment.md` |

This document covers E1-S1-T1 (#11), T2 (#12), T3 (#13) and T4 (#14). T5 (amend dashmeta Jira and move AIF tickets) is still live work in those projects.

## Attacker test

The test from the proposal: **does the harm need an attacker?**

- If money is lost, something goes down, a system falls out of support, or nobody knows what they own → **infrastructure → Farside**.
- If someone gains, abuses, or steals access → **security → dashmeta**.

A second reviewer should re-derive the three placements in [Reviewer probes](#reviewer-probes-e1-s1-t1). Those probes are the T1 check; they are not a substitute for a named human re-deriving them in review, but owner direction treats agreement-only steps as satisfied.

## Who covers what

| Area | Today | Under D1 |
|---|---|---|
| AWS assessment | Atlas, delivered by consultants, merging into dashmeta | Stays with Atlas |
| AWS cost | Atlas assessment checks; Ryan’s cost reporter and FinOps stack for Moonaan’s own accounts | Stays where it is |
| Security on any cloud | Dashmeta | Stays with dashmeta |
| Azure and GCP infrastructure and cost | Planned in dashmeta’s Atlas roadmap (DAS-775, DAS-776), not started | **Farside** |
| Microsoft 365 licenses and devices | — | Out of scope for Farside |

AWS stays with Atlas. Microsoft 365 licenses and devices stay out of scope.

## Launch checks and the attacker test

Every Azure and GCP launch check from the proposal is placed below. None of them need an attacker for the harm they name, so all sit on the Farside side of the test. Security checks (identity abuse, public exposure that an attacker uses, secret theft) are not in this launch set and stay with dashmeta.

Roles and API names are from the proposal’s general-knowledge lists. They are unverified until E1-S7 / E6-S1.

### Azure

| Check | Owner | Harm if ignored | Needs an attacker? |
|---|---|---|---|
| All resources by subscription, type, and region | Farside | Nobody knows what they own | No |
| Resources with no owner tag | Farside | Nobody knows who owns a thing | No |
| Unattached disks | Farside | Money spent on unused storage | No |
| Unassociated public IPs | Farside | Money spent on unused addresses | No |
| Old snapshots | Farside | Money spent on stale backups | No |
| VMs stopped but not deallocated | Farside | Compute still billed while idle | No |
| Empty App Service plans | Farside | Money spent on unused plans | No |
| Idle load balancers | Farside | Money spent on unused networking | No |
| Idle NAT gateways | Farside | Money spent on unused networking | No |
| Spend by service and month-on-month change | Farside | Cost is unknown or drifting | No |
| Reservation use | Farside | Paid commitment sitting unused | No |
| Savings plan use | Farside | Paid commitment sitting unused | No |
| Subscriptions without budgets | Farside | Overspend can run unnoticed | No |
| Production VMs outside Azure Backup | Farside | A production system can go down with no restore | No |
| Production SQL outside Azure Backup | Farside | A production database can go down with no restore | No |
| Databases without zone redundancy or geo-backup | Farside | A zone or region failure takes data with it | No |
| Retiring SKUs | Farside | A system falls out of support | No |
| Expiring App Service certificates | Farside | A site or gateway stops working | No |
| Expiring gateway certificates | Farside | A site or gateway stops working | No |

### GCP

| Check | Owner | Harm if ignored | Needs an attacker? |
|---|---|---|---|
| All assets by project and type | Farside | Nobody knows what they own | No |
| Resources with no owner label | Farside | Nobody knows who owns a thing | No |
| Unattached disks | Farside | Money spent on unused storage | No |
| Reserved but unused external IPs | Farside | Money spent on unused addresses | No |
| Old snapshots and images | Farside | Money spent on stale backups | No |
| Idle VM and disk recommendations | Farside | Money spent on unused compute or disk | No |
| Spend by service and project | Farside | Cost is unknown | No |
| Committed-use discount use | Farside | Paid commitment sitting unused | No |
| Cloud SQL without high availability or backups | Farside | A production database can go down | No |
| Out-of-support SQL and GKE versions | Farside | A system falls out of support | No |
| Expiring certificates | Farside | A service stops working | No |

## Reviewer probes (E1-S1-T1)

Re-derive these three from the attacker test without reading the owner column first.

1. **Azure unattached disk.** The disk is billed and unused. The harm is spend. No attacker is required. Owner: Farside.
2. **Azure expiring gateway certificate.** When it expires, traffic fails. The harm is an outage. No attacker is required. Owner: Farside. (A stolen cert would be security and would belong to dashmeta; this check is expiry, not theft.)
3. **GCP idle VM recommendation.** The recommender says capacity is unused. The harm is spend. No attacker is required. Owner: Farside. (A publicly open VM would be security and would belong to dashmeta; this check is idleness, not exposure.)

## Go or no-go (D6)

D6 is recorded as **go for in-repo work** (see `docs/decisions.md`). The original three conditions still describe live verification; they no longer block specs, fixtures, or CI.

| Condition | Owner | Status on 2026-11-02 |
|---|---|---|
| D1 closed (Farside owns Azure/GCP infra and cost) | Kevin and Ryan Morris; adopted by owner direction | Closed as a decision. Personal comments from Ryan and Kevin are not recorded. |
| D3 closed (Azure test subscription funded, plus empty second subscription, other tenant) | Zach DeManche and Kevin | Decision adopted. **Physical subscriptions do not exist** (E1-S5). |
| A named Azure prospect has said they would pay | Kevin and sales (D4) | Approach adopted. **Prospect is unnamed.** |

**Build start (in-repo):** yes, per owner direction. **Build start (live Azure data):** not recorded.

The week-8 continue-or-stop check in E2-S7 is separate and does not replace D6.

## Overlaps with DAS-775 and DAS-776 (E1-S1-T2)

Live Jira on 2026-11-02. Titles are copied from Jira; no ticket was edited. Proposed owner uses the attacker test. Ryan reading this list is satisfied by owner direction.

Amendment for Farside-owned rows, once T5 runs: Ryan Morris amends the dashmeta story to drop Azure/GCP **infrastructure and cost** from dashmeta, and points at Farside. Security, Entra, and Atlas-engagement packaging stay.

### Farside (infra / cost) — amend in dashmeta

| Key | Epic | Summary | Proposed owner | Amendment |
|---|---|---|---|---|
| DAS-942 | DAS-775 | Azure cost and usage collector with billing-scope, currency and period semantics | Farside | Move cost collector out of dashmeta. |
| DAS-943 | DAS-775 | Azure commitments collector: reservations, savings plans, utilization, coverage and expiry | Farside | Move commitments out of dashmeta. |
| DAS-944 | DAS-775 | Provider-aware price book, savings opportunities and service coverage for Azure | Farside | Move Azure savings/coverage out of dashmeta. |
| DAS-931 | DAS-775 | Azure discovery collector: tenant, management-group tree and subscription scope with honest coverage | Farside | Inventory hierarchy is a Farside launch need. |
| DAS-982 | DAS-776 | GCP billing evidence: billing accounts, project links and authorized billing export | Farside | Move GCP cost onboarding out of dashmeta. |
| DAS-983 | DAS-776 | GCP quota and commitment evidence: committed use discounts, reservations and quota headroom | Farside | Commitments → Farside. Quota-as-abuse stays dashmeta (see split). |
| DAS-984 | DAS-776 | GCP savings engine inputs, price book and service coverage classes | Farside | Move GCP savings inputs out of dashmeta. |
| DAS-967 | DAS-776 | GCP hierarchy discovery: organization, folders and projects with target allowlist | Farside | Inventory hierarchy is a Farside launch need. |

### Split (amend both)

| Key | Epic | Summary | Farside keeps | dashmeta keeps |
|---|---|---|---|---|
| DAS-919 | DAS-775 | Azure service inventory and read-operation specification with permission lockfile | Resource inventory for launch checks | Permission lockfile for security reads |
| DAS-923 | DAS-775 | Azure control specifications: cost and commitments, AI governance | Cost and commitments | AI governance |
| DAS-934 | DAS-775 | Azure organization and landing-zone collectors and checks | Subscription/org inventory | Landing-zone security posture |
| DAS-937 | DAS-775 | Azure compute and integration collectors and checks | Idle / stopped-not-deallocated waste | Compute exposure and hardening |
| DAS-938 | DAS-775 | Azure storage, backup and key-management collectors and checks | Backup coverage (resilience) | Storage exposure and key theft |
| DAS-939 | DAS-775 | Azure database and analytics collectors and checks | Backup / zone / geo (resilience) | Database exposure |
| DAS-940 | DAS-775 | Azure automation and monitoring collectors and checks | Lifecycle / support coverage | Monitoring as a security control |
| DAS-945 | DAS-775 | AKS cloud-service configuration collector and checks | Out-of-support versions (lifecycle) | Cluster hardening |
| DAS-961 | DAS-776 | GCP evidence semantics: inheritance, org policy, billing, quota and commitments | Billing, commitments | Org policy, inheritance, quota-as-abuse |
| DAS-972 | DAS-776 | GCP Organization and landing zone domain | Project inventory | Org-policy security |
| DAS-975 | DAS-776 | GCP Workload, compute and integration domain | Idle VM/disk waste | Compute exposure |
| DAS-978 | DAS-776 | GCP databases, warehouse and cache configuration | HA / backups | Database exposure |
| DAS-983 | DAS-776 | GCP quota and commitment evidence | Committed use / reservations | Quota headroom as abuse/DoS |

### Stay dashmeta (no Farside amendment)

Security, Entra, Atlas control-packaging, dashmeta platform connect, and portfolio UI. Harm needs an attacker, or the work is Atlas-engagement packaging Farside does not absorb.

**DAS-775:** DAS-920, 921, 922, 924, 925, 926, 927, 928, 929, 930, 932, 933, 935, 936, 941, 946, 947, 948, 949, 950, 951, 952, 953, 954, 955, 956, 957.

**DAS-776:** DAS-958, 959, 960, 962, 963, 964, 965, 966, 968, 969, 970, 971, 973, 974, 976, 977, 979, 980, 981, 985, 986, 987, 988, 989, 990, 991, 992, 993, 994.

Notable security rows (attacker test): DAS-935 identity/RBAC/Entra, DAS-936 network/edge, DAS-941 / DAS-981 AI governance, DAS-973 GCP IAM, DAS-974 GCP network, DAS-924 Entra consent.

## Jira review and handoff proposal (E1-S1-T3)

Lists match `docs/proposal.md` § Repo and Jira. Titles and statuses were read from Jira on 2026-11-02. **No ticket was edited, moved, or commented on.** Moves happen only in E1-S1-T5.

### Review for Farside (do not move yet)

| Key | Type | Summary in Jira | Status | Why it is on this list |
|---|---|---|---|---|
| AIF-454 | Epic | Consultant can deliver an Atlas engagement against an Azure estate | To Do | Proposal: Azure |
| AIF-455 | Epic | Consultant can deliver an Atlas engagement against a GCP estate | To Do | Proposal: GCP |
| AIF-462 | Epic | Consultant can put defensible licensing, contract and spend numbers in front of a client | To Do | Proposal: licensing, contracts, spend |
| AIF-503 | Story | Azure commercial licensing and cost evidence | In Progress | Proposal: in-progress under AIF-462 |
| AIF-509 | Story | GCP licensing and billing commercial evidence | In Progress | Proposal: in-progress under AIF-462 |

Farside would **review** these after D1, not absorb AIF’s Atlas-engagement packaging. Cost and infrastructure facts they collect are in Farside’s scope; Atlas-edition delivery stays a packaging question under D2 (separate product).

### Hand to dashmeta’s backlog (do not move yet)

| Key | Type | Summary in Jira | Status | Why it is on this list |
|---|---|---|---|---|
| AIF-456 | Epic | Consultant can deliver an Atlas engagement against the client's identity plane | To Do | Identity-plane / Entra. Harm needs an attacker or an identity-abuse path → dashmeta. |
| AIF-457 | Epic | Consultant can run a non-AWS harvest at engagement scale without losing evidence or breaching rate limits | To Do | Harvest-at-engagement-scale for Atlas. Not Farside’s continuous product. |
| AIF-459 | Epic | Client's promoted findings resolve to real, provider-neutral evidence no matter which cloud they came from | To Do | Atlas evidence-store seam. Stays with the Atlas/dashmeta merge. |

### Scan the AIF repo for client names before any port

Rule, copied from the proposal: **before porting from the AIF repo, scan it for client names.** No AIF code is ported in this change.

A read of Moonaan AIF backlog docs for ticket titles found at least one client engagement name. That name is **not** copied here. The scan in E1-S4-T2 must run on the AIF source tree before any connector port, and its output is attached there. This workspace did not clone the AIF repo.

## What this document does not do

- It does not claim Ryan Morris or Kevin posted a personal agreement.
- It does not move or amend dashmeta / AIF Jira (E1-S1-T5).
- It does not copy Atlas, dashmeta, or AIF source. Shared scan contracts remain E1-S2.
- It does not create Azure subscriptions (E1-S5) or verify roles live (E1-S7).

## Sign-off block

| Person | Agrees Farside owns Azure and GCP infrastructure and cost, dashmeta keeps security, AWS stays with Atlas | Date |
|---|---|---|
| Owner direction | Yes — D1 recommendation adopted. Does not replace a personal comment from Ryan or Kevin. | 2026-11-02 |
| Ryan Morris | _satisfied by owner direction; no personal comment recorded_ | 2026-11-02 |
| Kevin | _satisfied by owner direction; no personal comment recorded_ | 2026-11-02 |
