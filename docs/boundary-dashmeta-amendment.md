# Draft: dashmeta and AIF ticket amendments (E1-S1-T5, #15)

**Text only.** No Jira ticket has been edited, moved, or commented on. Ryan Morris (dashmeta) and the AIF owner paste these when they choose. Source lists and the attacker test: `docs/boundary.md`. Decision: D1 (`docs/decisions.md`).

Ticket titles were read on 2026-11-02. Re-read each ticket before pasting; if a title or status changed, adjust the text rather than forcing it.

## Shared paragraph

Paste at the top of every comment below.

> Per D1 (adopted 2026-11-02): Farside owns Azure and GCP **infrastructure and cost** (inventory, waste, commitments, resilience, lifecycle). dashmeta keeps **security** on every cloud. AWS stays with Atlas. Test: if the harm needs an attacker it is security; otherwise it is infrastructure. Boundary: Farside `docs/boundary.md`.

## dashmeta: move to Farside (description amendment)

Proposed action: add the comment, set resolution "Won't Do (moved to Farside)" or link a Farside issue, per dashmeta's convention. Do not delete.

| Key | Comment to paste after the shared paragraph |
|---|---|
| DAS-942 | Azure cost and usage collection (billing scope, currency, period) is built in Farside (`backend/src/cost.ts`). dashmeta no longer builds this collector. |
| DAS-943 | Azure reservations and savings plans (utilisation, coverage, expiry) are built in Farside (`backend/src/commitments.ts`). dashmeta no longer builds this collector. |
| DAS-944 | Azure savings ranges and service coverage live in Farside (`savings.ts`, coverage model). dashmeta keeps no Azure price book. |
| DAS-931 | Tenant, management-group and subscription discovery is a Farside launch need (`hierarchy.ts`). dashmeta reads Farside's inventory contract if it needs scope. |
| DAS-982 | GCP billing accounts, project links and billing export onboarding move to Farside (`gcp-billing-export.ts`). |
| DAS-984 | GCP savings inputs and coverage classes move to Farside (`gcp-recommender.ts`, savings ranges). |
| DAS-967 | GCP organization, folder and project discovery is a Farside launch need. dashmeta keeps its target allowlist for security reads. |

## dashmeta: split (description amendment, ticket stays open)

Proposed action: edit the description to remove the Farside half, add the comment. The ticket stays in dashmeta for the security half.

| Key | Remove from dashmeta scope (Farside) | Keep in dashmeta |
|---|---|---|
| DAS-919 | Resource inventory for launch checks | Permission lockfile for security reads |
| DAS-923 | Cost and commitments control specs | AI governance specs |
| DAS-934 | Subscription / org inventory | Landing-zone security posture |
| DAS-937 | Idle and stopped-not-deallocated compute waste | Compute exposure and hardening |
| DAS-938 | Backup coverage (resilience) | Storage exposure, key theft |
| DAS-939 | Backup, zone and geo redundancy (resilience) | Database exposure |
| DAS-940 | Lifecycle and support coverage | Monitoring as a security control |
| DAS-945 | Out-of-support AKS versions | Cluster hardening |
| DAS-961 | Billing and commitments evidence | Org policy, inheritance, quota as abuse |
| DAS-972 | Project inventory | Org-policy security |
| DAS-975 | Idle VM and disk waste | Compute exposure |
| DAS-978 | Cloud SQL HA and backups | Database exposure |
| DAS-983 | Committed use discounts, reservations | Quota headroom as abuse / DoS |

Comment template:

> Scope split under D1. Removed from this ticket: {Farside column}. That work is Farside's (see Farside `docs/boundary.md`). This ticket keeps: {dashmeta column}.

## dashmeta: no change

Every other DAS-775 / DAS-776 child listed under "Stay dashmeta" in `docs/boundary.md`. No comment needed.

## AIF: review for Farside

Proposed action: comment only. Do not move. Farside reviews these as inputs; Atlas-engagement packaging stays in AIF under D2.

| Key | Comment after the shared paragraph |
|---|---|
| AIF-454 | Azure infrastructure and cost facts are Farside's. Engagement packaging for Atlas-on-Azure stays here. Farside will read this epic's acceptance criteria as product input. |
| AIF-455 | Same as AIF-454, for GCP. |
| AIF-462 | Licensing, contract and spend numbers for Azure/GCP come from Farside's cost and commitment harvests. This epic keeps the consultant-facing presentation. |
| AIF-503 | In progress: before more Azure cost-evidence code lands here, compare with Farside `cost.ts` / `commitments.ts` to avoid a second implementation. |
| AIF-509 | Same as AIF-503, for GCP billing (`gcp-billing-export.ts`, `gcp-commitments.ts`). |

## AIF: hand to dashmeta

Proposed action: move to the dashmeta backlog (or link), with this comment.

| Key | Comment after the shared paragraph |
|---|---|
| AIF-456 | Identity plane / Entra: harm needs an attacker, so this is security. Handing to dashmeta. |
| AIF-457 | Engagement-scale non-AWS harvest is Atlas delivery, not Farside's continuous product. Handing to dashmeta with the Atlas merge. |
| AIF-459 | Provider-neutral evidence store is the Atlas/dashmeta seam. Handing to dashmeta. Farside publishes `@farside/scan-contracts` if a shared shape helps. |

## Before porting from AIF

The proposal's rule stands: scan the AIF source tree for client names before any port. Nothing in this draft names a client.

## Done when

- Each comment above is posted (or deliberately dropped) by the ticket owner.
- `docs/boundary.md` "Tickets changed" row is updated with the date and who posted.
- Until then #15 stays open; this file is the ready text.
