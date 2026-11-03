import type { FastifyBaseLogger, FastifyPluginAsync } from "fastify";
import type { BudgetClient } from "../budgets.js";
import type { Clock } from "../clock.js";
import type { CommitmentClient } from "../commitments.js";
import type { CostQueryClient } from "../cost.js";
import type { ScanRunner } from "../scans.js";
import type { ScanScheduler } from "../scheduler.js";
import type { MemoryStore } from "../store.js";

export type OrgParams = { orgId: string };

export type DemoReply = { status: number; body: unknown } | null;

declare module "fastify" {
  interface FastifyContextConfig {
    operator?: boolean;
    allowDeleted?: boolean;
    rejectSecrets?: boolean;
    invalidTitle?: string;
    demo?: (store: MemoryStore, orgId: string) => DemoReply;
  }
}

export type AppContext = {
  store: MemoryStore;
  clock: Clock;
  clientTime: (candidate: unknown) => string;
  trustClientClock: boolean;
  runner: ScanRunner;
  scheduler: ScanScheduler;
  log: FastifyBaseLogger;
  operatorToken: string | undefined;
  clients: {
    cost?: CostQueryClient | undefined;
    commitment?: CommitmentClient | undefined;
    budget?: BudgetClient | undefined;
  };
};

export type RoutePlugin = (ctx: AppContext) => FastifyPluginAsync;
