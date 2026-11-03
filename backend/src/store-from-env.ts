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
  throw new Error(`unsupported FARSIDE_STORE "${kind}"`);
}
