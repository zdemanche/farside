# Storage

Every route, the scan runner, the scheduler and the scheduled tick talk to `OrgRepository` (`backend/src/repository.ts`), never to a concrete store. `MemoryStore` is the default and the test implementation; `DynamoStore` persists to one DynamoDB table so a second Lambda container, a cold start and the 15-minute tick all see the same state.

| Variable | Meaning |
| --- | --- |
| `FARSIDE_STORE` | `memory` (default) or `dynamo`. Anything else fails at start-up. |
| `FARSIDE_TABLE_NAME` | Table name; required when `FARSIDE_STORE=dynamo`. |
| `FARSIDE_BLOB_BUCKET` | S3 bucket for documents over 300 KB; required when `FARSIDE_STORE=dynamo`. |

The Pulumi stack (`infra/src/stack.ts`) creates the table, sets both variables on the API and tick Lambdas and grants them only that table and its `gsi1` index.

## Table

One table per service, on-demand, point-in-time recovery on, encrypted at rest with the AWS-owned key, deletion protection outside `dev`. Keys use the Moonaan names: `pk`, `sk`, `gsi1pk`, `gsi1sk`.

## Entity definitions

`pk` is `ORG#<orgId>` for every item. Rows marked "document" carry `version` (number, incremented by every write), `entityType` (the `sk` prefix before `#`, for example `INV`, `CONN`, `SCAN`) and either `body` (the aggregate as a JSON string, up to 300 KB) or `blobKey` + `size` + `sha256` (the body lives in S3).

| `sk` | Entity | Shape | Written by |
| --- | --- | --- | --- |
| `META` | Org marker | `gsi1pk=ORGS`, `gsi1sk=ORG#<orgId>`, `latestInventory` (cloud) | first write for the org; `putInventory` |
| `SEQ` | Counters | `scan`, `schedule`, `connection` numbers | `nextSequence` (atomic `ADD`) |
| `CONN#<10-digit seq>` | Connection | document | `putConnection`, `patchConnection`, `deleteConnection` |
| `INV#<cloud>` | Inventory of one cloud | document, blob when large | `putInventory`, subscription drop, owner re-tag |
| `FACTS` | Resource facts | document, blob when large | `putFacts` |
| `FINDINGS` | Findings | document, blob when large | `putFindings` |
| `ISSUES` | Issues | document, blob when large | `putIssues` |
| `COV` | Coverage entries | document | `putCoverage`, cost currency marking |
| `COST#<subscriptionId>` | Cost snapshot | document | `putCost` |
| `COMMIT#<subscriptionId>` | Commitments snapshot | document | `putCommitments` |
| `BUDGETS`, `ALERTS`, `CONTRACT`, `SETTINGS` | Single snapshots | document | `putBudgets`, `putAlerts`, `putContract`, `putSettings` |
| `SCHEDULE` | Schedule state | document, version-checked | `updateSchedule` |
| `SCAN#<10-digit seq>` | Scan job | document plus top-level `status`, `complete` | `putJob`, `patchJob` (version-checked) |
| `SEEDED` | Demo org seed finished marker | document | `markSeeded` |
| `DELETION` | Deletion record (kept after offboard, no TTL) | document, `gsi1pk=DELETED`, `gsi1sk=deletedAt` | `offboard` |

Derived values are never stored: the combined `cost`, the combined `commitments` and the latest `inventory` are computed on read from the per-subscription and per-cloud items and `META.latestInventory`.

## Access patterns

| Pattern | Operation |
| --- | --- |
| Read one aggregate of an org | `GetItem` (single documents) or `Query pk, begins_with(sk, prefix)` (connections, inventories, costs, commitments, scans), consistent. Every read also looks up `DELETION` and fails with `DeletedOrgError` when it exists. |
| Replace one aggregate | Large body: `PutObject` to S3 first. Then `TransactWriteItems`: a `ConditionCheck` that `DELETION` does not exist, plus `UpdateItem` of the document header. The previous object is deleted afterwards. |
| Change cost, coverage, commitments, settings or drop a subscription | Load the affected documents, apply the same pure functions `MemoryStore` uses (`backend/src/org-ops.ts`), write only the documents whose JSON changed, each a live transact conditioned on the version loaded. |
| Next id | Live transact that sets `SEQ.#kind` to last-read + 1, conditioned on the value that was read; concurrent callers retry. |
| Schedule change | Read `SCHEDULE` with its `version`, apply the change, live transact conditioned on that version, retry on conflict. |
| Patch a scan | Same version-checked live transact on `SCAN#<seq>`. |
| Cap scans | After a `putJob` past the 200-scan cap: count query, then a projection of `sk`, `status`, `complete`, then delete the oldest settled scans. |
| List orgs (tick, retention sweep) | `Query gsi1` where `gsi1pk = "ORGS"`. Eventually consistent: an org written a moment ago may appear on the next tick. |
| Offboard | Write `DELETION` (conditional, first writer wins, projected on `gsi1` as `DELETED` / `deletedAt`), then delete the org prefix in S3 and `Query pk` + `BatchWriteItem` everything else, twice. A repeat call purges leftovers and returns the same record. |
| Re-purge | Each scheduled tick queries `gsi1pk = "DELETED"` for `deletedAt` in the last 48 hours and runs the same purge again. `MemoryStore` no-ops. |
| Retention sweep | `orgIds()`, then one `CONTRACT` read per org. |

## Large aggregates

DynamoDB items stop at 400 KB, so a document whose JSON is over 300 KB is stored as one S3 object, `ORG#<orgId>/<sk>/<generation>.json` (private bucket, SSE-S3, no versioning), and its header item holds `blobKey`, `size` and `sha256`. The header update is the switch: a reader sees either the old or the new object, and the previous object is deleted after the switch. A reader that finds the object missing (S3 reports a missing key as 404 only because the Lambda role may list the bucket) or not matching `sha256` (it was replaced while being read) re-reads the header once and retries, then fails. Deleting the superseded object is best effort: a failure is logged and the orphan is swept at offboard, and the new object is only removed when the header write itself loses its version check. Objects orphaned by a crash between the upload and the header write are removed at offboard (the whole `ORG#<orgId>/` prefix is deleted; per-key delete errors are retried with backoff and then fail the offboard so it can be re-run). The bucket denies non-TLS requests. `BlobStore` (`backend/src/blob-store.ts`) is the seam: `S3BlobStore` in production, `MemoryBlobStore` in tests.

## Concurrency guarantees

Every live write (document header, `META`, `SEQ`) is a `TransactWriteItems` of a `ConditionCheck` that `DELETION` does not exist plus the Put/Update. A cancellation on that check is `DeletedOrgError`; a cancellation on the write's own condition is `ConditionalCheckFailedException`, which the existing retry loops already handle. IAM grants `dynamodb:ConditionCheckItem` (there is no `TransactWriteItems` action). The in-process dynalite used by `npm test` has no transact API; the contract suite emulates `TransactWriteItems` there. CI also runs the same suite against `amazon/dynamodb-local`, which does.

- **Versioned documents.** Every document write adds 1 to `version` inside that transact. A change that touches several documents (`putCost`, `putCoverage`, `putCommitments`, `putSettings`, disconnect) loads them with their versions, writes each changed one conditioned on the loaded version and, if any write finds the document moved, reloads and applies the change again (up to 12 attempts, with jittered backoff; on exhaustion the error lists which documents the last attempt had already written). Blind replaces (`putFindings`, `putFacts`, `putIssues`, `putInventory`, budgets, alerts, contract) also bump `version`, so they make a concurrent multi-document change retry rather than be overwritten with stale data. A scan's merge is not a series of replaces: `mergeScan` runs the inventory, facts, findings, coverage and issues merge inside one versioned change, so a conflict re-merges from fresh state and two containers scanning different subscriptions of one org keep both results.
- **Offboard.** `offboard` writes the `DELETION` item first (conditional, first writer wins, `gsi1pk=DELETED`) and only then purges, twice. A live transact cannot commit once that marker exists, so a writer that dies after sending the write cannot leave a new item behind. Writes that committed before the marker are removed by the purge. The scheduled tick re-purges orgs whose `deletedAt` is in the last 48 hours, so a leftover from a frozen writer or a raw write is still removed. Nothing but the deletion record survives an offboard. `ScanRunner` also reads `DELETION` through the repository before its merge, so a scan in another container stops without relying on the in-process abort.
- **Disconnect.** Removing the last connection for a subscription and dropping its data is one versioned multi-document change. A scan merge is a series of blind replaces, so after merging `ScanRunner` re-checks that the subscription is still connected; if not, it calls `purgeSubscription` (drops the subscription's data when no connection uses it) and cancels the scan. Either the disconnect saw the scan's writes, or the scan sees the disconnect and cleans up after itself.

## What is not guaranteed

- Blind replaces other than the scan merge are last-writer-wins against each other. The per-org scan queue and duplicate-start guard (`ScanRunner`) are in-process.
- `offboard` aborts only the scans running in its own process; scans elsewhere stop at their next repository call.
- The egress guard's `WeakSet` (`markVerified`) cannot survive a round trip through DynamoDB and `DynamoStore` does not mark what it reads, so `sendStored` walks those bodies. Write-time `assertNoSecrets` is unchanged.
- A never-written org reads its default settings with `updatedAt` set to the read time.

## Demo org

The demo org is seeded with fixed ids (`conn-1`, `scan-1`) written conditionally (the counters are raised to at least those numbers), then a `SEEDED` marker last. Two containers seeding at once do not duplicate anything, and a seed that stopped part-way is finished by the next request because it is only "done" when the marker exists.

## Tests

`backend/src/repository.contract.test.ts` runs one suite against `MemoryStore` and `DynamoStore`. `DynamoStore` runs against `dynalite` started in-process on an ephemeral port, so no Docker or Java is needed locally; with `DYNAMO_ENDPOINT` set it runs against that endpoint instead, and CI does so against an `amazon/dynamodb-local` service container (job `repository-dynamodb-local`). Blobs use `MemoryBlobStore`. It covers CRUD per aggregate, the scan cap, concurrent sequence and schedule updates, an inventory stored as a blob, offboard, the live transact guard, the 48-hour re-purge, retention and a second instance reading the first one's state. Dynalite emulates the DynamoDB API and not transactions; a test shim covers `TransactWriteItems` there. Real throttling, GSI lag, IAM and native transact are unverified until dynamodb-local / the stack is applied.
