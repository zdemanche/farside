# Storage

Every route, the scan runner, the scheduler and the scheduled tick talk to `OrgRepository` (`backend/src/repository.ts`), never to a concrete store. `MemoryStore` is the default and the test implementation; `DynamoStore` persists to one DynamoDB table so a second Lambda container, a cold start and the 15-minute tick all see the same state.

| Variable | Meaning |
| --- | --- |
| `FARSIDE_STORE` | `memory` (default) or `dynamo`. Anything else fails at start-up. |
| `FARSIDE_TABLE_NAME` | Table name; required when `FARSIDE_STORE=dynamo`. |

The Pulumi stack (`infra/src/stack.ts`) creates the table, sets both variables on the API and tick Lambdas and grants them only that table and its `gsi1` index.

## Table

One table per service, on-demand, point-in-time recovery on, encrypted at rest with the AWS-owned key, deletion protection outside `dev`. Keys use the Moonaan names: `pk`, `sk`, `gsi1pk`, `gsi1sk`.

## Entity definitions

`pk` is `ORG#<orgId>` for every item. Rows marked "document" carry `version` (number) and either `body` (the aggregate as a JSON string, up to 300 KB) or `gen` + `parts` (the body split over chunk items).

| `sk` | Entity | Shape | Written by |
| --- | --- | --- | --- |
| `META` | Org marker | `gsi1pk=ORGS`, `gsi1sk=ORG#<orgId>`, `latestInventory` (cloud) | first write for the org; `putInventory` |
| `SEQ` | Counters | `scan`, `schedule`, `connection` numbers | `nextSequence` (atomic `ADD`) |
| `CONN#<10-digit seq>` | Connection | document | `putConnection`, `patchConnection`, `deleteConnection` |
| `INV#<cloud>` | Inventory of one cloud | document, chunked | `putInventory`, subscription drop, owner re-tag |
| `FACTS` | Resource facts | document, chunked | `putFacts` |
| `FINDINGS` | Findings | document, chunked | `putFindings` |
| `ISSUES` | Issues | document, chunked | `putIssues` |
| `COV` | Coverage entries | document | `putCoverage`, cost currency marking |
| `COST#<subscriptionId>` | Cost snapshot | document | `putCost` |
| `COMMIT#<subscriptionId>` | Commitments snapshot | document | `putCommitments` |
| `BUDGETS`, `ALERTS`, `CONTRACT`, `SETTINGS` | Single snapshots | document | `putBudgets`, `putAlerts`, `putContract`, `putSettings` |
| `SCHEDULE` | Schedule state | document, version-checked | `updateSchedule` |
| `SCAN#<10-digit seq>` | Scan job | document plus top-level `status`, `complete` | `putJob`, `patchJob` (version-checked) |
| `CHUNK#<sk>#<gen>#<index>` | Body piece of a chunked document | `body` | any chunked write |
| `DELETION` | Deletion record (kept after offboard, no TTL) | document | `offboard` |

Derived values are never stored: the combined `cost`, the combined `commitments` and the latest `inventory` are computed on read from the per-subscription and per-cloud items and `META.latestInventory`.

## Access patterns

| Pattern | Operation |
| --- | --- |
| Read one aggregate of an org | `GetItem` (single documents) or `Query pk, begins_with(sk, prefix)` (connections, inventories, costs, commitments, scans), consistent. Every read also looks up `DELETION` and fails with `DeletedOrgError` when it exists. |
| Replace one aggregate | `PutItem` of the document (chunks first, header last, superseded chunks deleted after). |
| Change cost, coverage, commitments, settings or drop a subscription | Load the affected documents, apply the same pure functions `MemoryStore` uses (`backend/src/org-ops.ts`), write only the documents whose JSON changed. |
| Next id | `UpdateItem ADD` on `SEQ`; atomic, so concurrent callers get distinct numbers. |
| Schedule change | Read `SCHEDULE` with its `version`, apply the change, `PutItem` conditioned on that version, retry on conflict. |
| Patch a scan | Same version-checked read-modify-write on `SCAN#<seq>`. |
| Page scans | `Query begins_with(sk, "SCAN#")` with `Limit` and the previous page's last key. The 200-scan cap is enforced after a `putJob` past the cap (count query, then projection of `sk`, `status`, `complete`). |
| List orgs (tick, retention sweep) | `Query gsi1` where `gsi1pk = "ORGS"`. Eventually consistent: an org written a moment ago may appear on the next tick. |
| Offboard | Write `DELETION` (conditional, first writer wins), then `Query pk` and `BatchWriteItem` delete everything else. A repeat call purges leftovers and returns the same record. |
| Retention sweep | `orgIds()`, then one `CONTRACT` read per org. |

## Large aggregates

DynamoDB items stop at 400 KB. A document whose JSON is over 300 KB is split into pieces of at most 100,000 characters (never between the halves of a surrogate pair), stored as `CHUNK#` items under a new generation id; the header item is written last and is the switch, so a reader sees either the old or the new body. Superseded chunks are deleted after the header write; chunks orphaned by a crash are removed at offboard.

## What is not guaranteed

- Documents other than `SCHEDULE` and scans are last-writer-wins. Within one org the scan runner serialises scans and HTTP writes are infrequent, but two containers can still interleave a read-modify-write of `COV`, `FINDINGS` or `ISSUES`.
- The per-org scan queue and duplicate-start guard (`ScanRunner`) are in-process. Two containers can each start a scan for the same subscription; the tick Lambda runs alone on a 15-minute schedule so this needs an API request landing in the same minute.
- `offboard` aborts only the scans running in its own process.
- The egress guard's `WeakSet` (`markVerified`) cannot survive a round trip through DynamoDB, so `sendStored` walks bodies read from `DynamoStore`. Write-time `assertNoSecrets` is unchanged.
- A never-written org reads its default settings with `updatedAt` set to the read time.

## Tests

`backend/src/repository.contract.test.ts` runs one suite against `MemoryStore` and `DynamoStore`. `DynamoStore` runs against `dynalite` started in-process on an ephemeral port, so no Docker or Java is needed. It covers CRUD per aggregate, scan paging and the cap, concurrent sequence and schedule updates, a multi-chunk inventory, offboard, retention and a second instance reading the first one's state. Dynalite emulates the DynamoDB API; it is not DynamoDB, so real throttling, GSI lag and IAM are unverified until the stack is applied.
