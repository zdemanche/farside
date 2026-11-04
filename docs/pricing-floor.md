# Pricing floor note

For Kevin (E2-S7-T4 / #82). D4: list price stays **above** the cost of one dedicated customer account plus the test estate. These are estimates. No dedicated account or Azure subscription has a bill in this workspace.

## Dedicated Farside account (AWS)

`infra/src/plan.ts` `planDevStack` names what we deploy per customer:

| Kind | Count | Role |
|---|---|---|
| Lambda | 2 | API + 15-minute tick |
| DynamoDB table | 1 | on-demand, PITR |
| S3 buckets | 2 | store blobs + console |
| CloudFront | 1 | console only |
| EventBridge Scheduler | 1 | `rate(15 minutes)` |
| Log groups | 2 | API + tick |
| SSM SecureString | 1 | operator token |
| IAM roles | 3 | API, tick, scheduler |

At one customer, one scan an hour, and a few thousand inventory rows, a current public-price sketch is **USD 20–40 / month**. Drivers: DynamoDB on-demand reads on `/estate` and `/inventory`, CloudFront, and CloudWatch logs. Idle Lambdas and the scheduler are cents. This is **not** a Cost Explorer extract.

## Test Azure estate

The seed in `docs/azure/ground-truth.json` is the intended estate: one waste subscription plus `empty-no-budget`. Reader-class roles are free. Expected Azure cost if the seed is applied: the unattached disk, stopped-allocated VM, idle LB/NAT, and public IP — **low tens of USD / month** if left running, closer to **single digits** if the stopped VM is deallocated after the demo. Cost Management history does not exist until the subscription is created (E1-S5 leftover).

GCP (D7) is a later estate. Do not fold a project bill into this floor until E6 has a project.

## Floor

| Item | Estimate (USD / month) | Source |
|---|---|---|
| Dedicated AWS account | 20–40 | Stack plan + public prices |
| Azure test estate | 5–30 | Seed SKUs, not a portal bill |
| **Combined floor** | **25–70** | Sum of ranges |

List price for a paying customer must sit **above 70 USD / month** until a real bill replaces the high end. A prospect price of 100+ leaves room for support and the empty first month of Cost Management.

## What this is not

- Not a quote.
- Not verified against Cost Explorer or the Azure portal.
- Not a commit to the 20–40 AWS band after the first paying customer (blob storage and scan history will grow).

Kevin: read this note and replace the ranges when the dedicated account and test subscription have a month of actuals.
