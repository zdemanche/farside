import { systemClock, type Clock } from "./clock.js";
import { silentLog, type LogSink } from "./observability.js";
import type { OrgRepository } from "./repository.js";
import { MemoryStore } from "./store.js";

export async function storeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  clock: Clock = systemClock,
  log: LogSink = silentLog,
): Promise<OrgRepository> {
  const kind = env.FARSIDE_STORE ?? "memory";
  if (kind === "memory") {
    return new MemoryStore(clock);
  }
  if (kind !== "dynamo") {
    throw new Error(`unsupported FARSIDE_STORE "${kind}"`);
  }
  const table = env.FARSIDE_TABLE_NAME;
  if (!table) {
    throw new Error("FARSIDE_TABLE_NAME is required when FARSIDE_STORE=dynamo");
  }
  const bucket = env.FARSIDE_BLOB_BUCKET;
  if (!bucket) {
    throw new Error("FARSIDE_BLOB_BUCKET is required when FARSIDE_STORE=dynamo");
  }
  const { DynamoStore, documentClient } = await import("./dynamo-store.js");
  const { S3BlobStore } = await import("./s3-blob-store.js");
  return new DynamoStore(documentClient(), table, new S3BlobStore(bucket), clock, log);
}
