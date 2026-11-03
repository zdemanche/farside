import { buildApp } from "./app.js";
import { systemClock } from "./clock.js";
import { MemoryStore, runRetentionSweep } from "./store.js";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const host = process.env.HOST ?? "0.0.0.0";
const RETENTION_SWEEP_MS = 3_600_000;

const store = new MemoryStore(systemClock);
const app = buildApp(store, {
  clock: systemClock,
  operatorToken: process.env.FARSIDE_OPERATOR_TOKEN || undefined,
});

setInterval(() => {
  try {
    runRetentionSweep(store, systemClock);
  } catch (error) {
    app.log.error({ err: error }, "retention sweep failed");
  }
}, RETENTION_SWEEP_MS).unref();

await app.listen({ port, host });
app.log.info({ port, host }, "farside backend listening");
