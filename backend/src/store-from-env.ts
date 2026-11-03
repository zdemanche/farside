import { systemClock, type Clock } from "./clock.js";
import type { OrgRepository } from "./repository.js";
import { MemoryStore } from "./store.js";

export async function storeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  clock: Clock = systemClock,
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
  const { DynamoStore, documentClient } = await import("./dynamo-store.js");
  return new DynamoStore(documentClient(), table, clock);
}
