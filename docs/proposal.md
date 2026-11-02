# Proposal: Farside, Azure and GCP infrastructure

**Status:** draft proposal for discussion, revised 2026-11-01. Nothing has been built, filed, or created.
**Author:** Zach DeManche

Atlas and Ryan's cost work cover AWS. Azure and GCP have nothing live. Farside would fill that gap with a continuous product that connects to a customer's Azure or GCP estate, scans it, tracks issues, and shows what's costing money, about to break, out of support, or not known to exist.

| Milestone | Rough time |
|---|---|
| Real Azure data | ~8 engineer-weeks, range 7 to 11, if a test subscription exists by week 4 |
| First sellable version, Azure only | ~23 weeks, range 19 to 29 |
| Azure and GCP | ~31 weeks, range 25 to 40 |

Estimates assume sdlc agents build while one engineer reviews. No Azure or GCP code in any Moonaan repo has run live, so treat them as soft.

## What changed from the first version

The first version proposed an AWS-first product that took cost ownership away from Atlas. That was wrong: Atlas is at version 1.16 with an engagement delivered and cost checks built, and Ryan already has AWS cost reporting. This version drops AWS from Farside and leaves AWS with Atlas.

Microsoft 365 licenses and devices also leave scope for now. That removes about 12 weeks from the earlier plan.

## Who covers what

| Area | Today | Under this proposal |
|---|---|---|
| AWS assessment | Atlas, delivered by consultants, merging into dashmeta | Stays with Atlas |
| AWS cost | Atlas assessment checks; Ryan's cost reporter and FinOps stack for Moonaan's own accounts | Stays where it is |
| Security on any cloud | Dashmeta | Stays with dashmeta |
| Azure and GCP infrastructure | Planned in dashmeta's Atlas roadmap, not started | Farside, if decision 1 agrees |

**The test for any check: does the harm need an attacker?** If money is lost, something goes down, a system falls out of support, or nobody knows what they own, it's infrastructure. If someone gains, abuses, or steals access, it's security and stays with dashmeta.

### What makes this different from Atlas

Atlas is a point-in-time engagement that a consultant delivers on AWS. Farside would run continuously for the customer's own team, on the clouds Atlas doesn't reach. Both follow the same evidence rules, so results can sit side by side.

## Decisions needed

| # | Decision | Recommendation | Why |
|---|---|---|---|
| 1 | Who builds Azure and GCP infrastructure? | **Farside builds infrastructure and cost. Dashmeta keeps security.** Needs Ryan Morris and Kevin to agree, and dashmeta's roadmap amended. | Dashmeta's epics DAS-775 (Azure) and DAS-776 (GCP) cover the same cost scope, including DAS-923, 942 to 944, 982, and 983. No work has started on them; as of 2026-10-11 that program was paused in wave 2 of 30. Without agreement, this gets built twice. |
| 2 | Separate product, or the Azure/GCP edition of Atlas inside dashmeta? | **Separate product on shared formats**, so it can be sold alone and run continuously. If the owners prefer it inside dashmeta, the same work moves there. | Atlas is merging into dashmeta, so this needs a deliberate answer. The Azure and GCP work is the same either way; only the packaging changes. |
| 3 | What do we test on? | **Fund one Azure subscription now and seed it with deliberate waste,** ready by week 4. | No Moonaan Azure subscription or GCP project was found in iac-hub or org code search. Without one there is no real data at week 8, and no way to measure false positives. |
| 4 | Who buys first? | **Name one prospect running mainly on Azure, and show them the Phase 1 version around week 8.** | This tests demand before the larger spend. Pricing should stay above the cost of a dedicated account. |

### Go or no-go

Start building only if all three are true:

1. Kevin and Ryan agree on decision 1.
2. An Azure test subscription is funded.
3. One real Azure prospect says they'd pay for it.

### Proposed defaults

- **Accounts:** Moonaan-owned and dedicated to each customer, in the standard Moonaan setup.
- **New repo:** `Moonaan/moonaan-farside`, using dashmeta's scan formats and its own deployment and issue store.
- **Stack:** Moonaan Identity, iac-hub `PRODUCTS` registration, and a new React/TypeScript console using the AIF Program UI's design.
- **Name:** Farside, once a trademark search clears it. Key `farside`, address `farside.<customer>.moonaan.com`.

## What Farside does

Connect → Scan → Coverage → Findings → Issues → Console

**What the CTO sees first:** "Your Azure costs $X a month, and $Y is waste we can name. N of M production systems aren't backed up. K things lose support in 90 days. Here is what we could not see."

### Azure launch checks

Read-only roles: Reader, Cost Management Reader, Monitoring Reader, Reservations Reader, and Backup Reader if vault items are needed.

| Area | Checks |
|---|---|
| Inventory | All resources by subscription, type, and region; resources with no owner tag |
| Waste | Unattached disks, unassociated public IPs, old snapshots, VMs stopped but not deallocated, empty App Service plans, idle load balancers and NAT gateways |
| Cost | Spend by service and month-on-month change; reservation and savings-plan use; subscriptions without budgets |
| Resilience | Production VMs and SQL outside Azure Backup; databases without zone redundancy or geo-backup |
| Lifecycle | Retiring SKUs; expiring App Service and gateway certificates |

### GCP launch checks

Read-only roles: Cloud Asset Viewer, Compute Viewer, Recommender Viewer, Cloud SQL Viewer, Certificate Manager Viewer, and BigQuery access to the billing export.

| Area | Checks |
|---|---|
| Inventory | All assets by project and type; resources with no owner label |
| Waste | Unattached disks, reserved but unused external IPs, old snapshots and images, idle VM and disk recommendations |
| Cost | Spend by service and project; committed-use discount use |
| Resilience | Cloud SQL without high availability or backups |
| Lifecycle | Out-of-support SQL and GKE versions; expiring certificates |

**GCP cost has a catch:** there's no cost API to query. The customer must first enable the BigQuery billing export, which fills only from that day forward, so the cost view starts empty.

The role lists and API behavior come from general cloud knowledge and haven't been tested live. Phase 0 verifies them.

### Console

- **Estate overview:** the headline and a health score.
- **Connect, Scans, and Settings:** the same shape as dashmeta's.
- **Inventory:** everything found, by owner and service.
- **Issues:** the work queue, with proof of coverage.
- **Cost and waste, Lifecycle, Recovery:** one page for each outcome.
- **Blind spots:** what couldn't be checked and why.

## What we reuse

| Source | Action | Detail |
|---|---|---|
| Atlas | Follow the pattern | Harvest and check as separate steps, no finding without evidence, `undetermined` results that say what would close them, and savings as ranges. Its catalog is AWS-only, so Azure and GCP need new control sets. |
| Atlas checks | Use as a guide | Waste, commitments, budgets, tags, cost export, rightsizing, engine versions, and certificate expiry all have Azure or GCP equivalents. No code ports directly. |
| Ryan's cost reporter | Reuse the method | Floor vs burst and its four alert rules port well. Thresholds are tuned to Moonaan's spend, so they must become relative and be re-tested. |
| Dashmeta scan contracts | Share | Formats for checks, inventory, coverage, and findings. Additions need Ryan's sign-off. |
| Dashmeta Azure adapter | Extend | A Resource Graph client tested on fakes only. It supports one resource type today. |
| AIF `connector-azure` and `connector-gcp` | Port selectively | Azure roles and hierarchy discovery, and GCP collectors. Neither has run live. |
| AIF Program UI | Rebuild | Keep its design, navigation, and accessibility tests in a new app. |
| This repo | Nothing | It holds real client data, and its subject belongs to dashmeta. No code or data from it ships in Farside. |

Dashmeta's Azure auth is a client secret, and its GCP auth is a pasted token. Only AWS has a connect flow, so Azure and GCP connection is new work.

## Build order

| Phase | Outcome | Eng-weeks | Running total |
|---|---|---|---|
| 0. Foundations | Boundary agreed, contracts settled, repo created, Azure control spec written | 2 | 2 |
| 1. Azure inventory | Sign in, connect a subscription, and see the Estate overview and Blind spots. Show one prospect. | 6 | 8 |
| 2. Azure issues | Non-cost checks, with Scans and Issues screens | 6 | 14 |
| 3. Azure cost | Spend, floor and burst, alerts, reservations, and the CTO headline | 5 | 19 |
| 4. Ready to sell | Demo data, offboarding, billing, scheduler, and export | 4 | 23 |
| 5. GCP | Connection, billing export onboarding, and 10 checks | 8 | 31 |

Azure-only takes about the same as the earlier AWS plan. Atlas's patterns save time, but AWS had a live-proven path and Azure has none.

## From sale to dashboard

| Step | Today |
|---|---|
| Contract and billing | Gap. Dashmeta has a billing screen worth reviewing. |
| Register in iac-hub, create the account, deploy base, Identity, and Launch | Exists; the account step is operator-run |
| Deploy Farside | Mechanism exists; Farside doesn't yet |
| CTO claims the org and signs in | Exists, rehearsed on a test tenant |
| Connect Azure or GCP | New work |
| First scan and scheduled scans | New work. No shared scheduler exists. |

## Repo and Jira

No Jira tickets have changed. Proposed, subject to decision 1:

- **Review for Farside:** AIF-454 (Azure), AIF-455 (GCP), and AIF-462 (licensing, contracts, spend), with in-progress AIF-503 and 509.
- **Hand to dashmeta's backlog:** AIF-456, 457, and 459.
- **Amend in dashmeta:** the infrastructure and cost stories under DAS-775 and DAS-776.
- **Before porting from the AIF repo:** scan it for client names.

## Main risks

- **Nothing is proven live, and there's no test estate.** Week 8 and every check's accuracy depend on decision 3.
- **Collision with dashmeta's Azure and GCP plans.** Without agreement we build twice, or Atlas has no Azure to merge with.
- **Continuous means unattended.** It needs a scheduler and proper federated credentials from Phase 1, neither of which exists for these clouds.
- **GCP depends on customer setup.** Without the billing export, there's no cost view and no history.
- **Azure pricing varies.** Billing scopes and currency differ by agreement type, so cost code needs testing beyond one subscription.

## Sources

Based on a read of atlas-aws, moonaan-cost-reporter, moonaan-platform-cost, dashmeta's cloud, platform, and contracts repos, the AIF repo, iac-hub, and Moonaan Identity, plus Kevin's feedback on the first version. Dashmeta status comes from its docs, not live Jira. Neither console was run. No Moonaan repo or code uses the name Farside, and two web searches found no security company with that name; the closest is Farsight Security. A trademark search is still needed.
