import { randomUUID } from "node:crypto";
import Fastify, { LogController } from "fastify";
import type { DigestMailer } from "./alerts.js";
import { defaultRoleLister, type RoleLister } from "./role-probe.js";
import type { BudgetClient } from "./budgets.js";
import type { Clock } from "./clock.js";
import type { CommitmentClient } from "./commitments.js";
import type { CostQueryClient } from "./cost.js";
import { guardClientSource, guardHarvester } from "./demo.js";
import type { AppContext, RoutePlugin } from "./http/context.js";
import { registerHttp } from "./http/hooks.js";
import { pinoOptions, type LoggerOptions } from "./observability.js";
import { createAuthenticator, type IdentityOptions } from "./identity.js";
import { alertRoutes } from "./routes/alerts.js";
import { claimRoutes } from "./routes/claim.js";
import { commitmentRoutes } from "./routes/commitments.js";
import { connectionRoutes } from "./routes/connections.js";
import { contractRoutes } from "./routes/contract.js";
import { costRoutes } from "./routes/cost.js";
import { coverageRoutes } from "./routes/coverage.js";
import { estateRoutes } from "./routes/estate.js";
import { exportRoutes } from "./routes/export.js";
import { healthRoutes } from "./routes/health.js";
import { inventoryRoutes } from "./routes/inventory.js";
import { offboardRoutes } from "./routes/offboard.js";
import { scanRoutes } from "./routes/scans.js";
import { settingsRoutes } from "./routes/settings.js";
import { ScanRunner, unconfiguredHarvester, type HarvestClientSource, type Harvester } from "./scans.js";
import type { OrgRepository } from "./repository.js";
import { ScanScheduler } from "./scheduler.js";

export { SERVICE_NAME } from "./routes/health.js";

const ROUTE_PLUGINS: RoutePlugin[] = [
  healthRoutes,
  connectionRoutes,
  inventoryRoutes,
  coverageRoutes,
  estateRoutes,
  scanRoutes,
  costRoutes,
  commitmentRoutes,
  alertRoutes,
  exportRoutes,
  settingsRoutes,
  contractRoutes,
  offboardRoutes,
  claimRoutes,
];

export function buildApp(
  store: OrgRepository,
  options: {
    harvester?: Harvester;
    /** Per-scan clients (live Azure). Wins over the static clients for scans only. */
    harvestClients?: HarvestClientSource;
    costClient?: CostQueryClient;
    commitmentClient?: CommitmentClient;
    budgetClient?: BudgetClient;
    clock?: Clock;
    trustClientClock?: boolean;
    operatorToken?: string | undefined;
    logger?: LoggerOptions;
    scanTimeoutMs?: number;
    mailer?: DigestMailer;
    roleLister?: RoleLister;
    /** Bearer-token identity (#48). Omit to keep the x-farside-org / x-farside-actor header session. */
    identity?: IdentityOptions | undefined;
  } = {},
) {
  const clock = options.clock ?? store.clock;
  const trustClientClock = options.trustClientClock === true;
  const app = Fastify({
    logger: pinoOptions(options.logger),
    genReqId: () => randomUUID(),
    logController: new LogController({ disableRequestLogging: true }),
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  const clients = {
    cost: options.costClient,
    commitment: options.commitmentClient,
    budget: options.budgetClient,
  };
  const runner = new ScanRunner(
    store,
    guardHarvester(options.harvester ?? unconfiguredHarvester()),
    options.harvestClients
      ? guardClientSource(options.harvestClients)
      : {
          ...(clients.cost ? { costClient: clients.cost } : {}),
          ...(clients.commitment ? { commitmentClient: clients.commitment } : {}),
          ...(clients.budget ? { budgetClient: clients.budget } : {}),
        },
    clock,
    app.log,
    options.scanTimeoutMs,
  );
  const ctx: AppContext = {
    store,
    clock,
    trustClientClock,
    clientTime: (candidate) =>
      trustClientClock && typeof candidate === "string" ? candidate : clock(),
    runner,
    scheduler: new ScanScheduler(store, runner, clock, app.log),
    log: app.log,
    operatorToken: options.operatorToken,
    mailer: options.mailer,
    roleLister: options.roleLister ?? defaultRoleLister(),
    identity: options.identity
      ? { config: options.identity, authenticate: createAuthenticator(options.identity) }
      : undefined,
    clients,
  };

  registerHttp(app, ctx);
  for (const plugin of ROUTE_PLUGINS) {
    void app.register(plugin(ctx));
  }

  return app;
}
