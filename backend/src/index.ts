import { buildApp } from "./app.js";
import { azureLiveFromEnv } from "./azure-live-harvest.js";
import { systemClock } from "./clock.js";
import { identityConfigFromEnv } from "./identity.js";
import { pino } from "pino";
import { auditRetention, loggerFromEnv, pinoOptions } from "./observability.js";
import { storeFromEnv } from "./store-from-env.js";
import { runRetentionSweep } from "./store.js";
import { unconfiguredHarvester } from "./scans.js";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const host = process.env.HOST ?? "0.0.0.0";
const RETENTION_SWEEP_MS = 3_600_000;

const store = await storeFromEnv(process.env, systemClock, pino(pinoOptions(loggerFromEnv()) || {}));
const live = azureLiveFromEnv(process.env, { store, fallback: unconfiguredHarvester(), clock: systemClock });
const app = buildApp(store, {
  clock: systemClock,
  ...(live ? { harvester: live.harvester, harvestClients: live.harvestClients, roleLister: live.roleLister } : {}),
  logger: loggerFromEnv(),
  operatorToken: process.env.FARSIDE_OPERATOR_TOKEN || undefined,
  identity: identityConfigFromEnv(process.env),
});

setInterval(() => {
  runRetentionSweep(store, systemClock)
    .then((records) => auditRetention(app.log, records))
    .catch((error: unknown) => app.log.error({ err: error }, "retention sweep failed"));
}, RETENTION_SWEEP_MS).unref();

await app.listen({ port, host });
app.log.info({ port, host }, "farside backend listening");
