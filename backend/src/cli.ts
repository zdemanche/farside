import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CLOUDS, type Cloud, type Finding, type Inventory } from "@farside/scan-contracts";
import { fixtureBudgetClient } from "./budgets.js";
import { systemClock, type Clock } from "./clock.js";
import { fixtureCommitmentClient } from "./commitments.js";
import { fixtureCostClient, type CostSnapshot } from "./cost.js";
import {
  EXPORT_FORMAT,
  type ExportInventoryRow,
  exportCost,
  exportFilename,
  exportInventory,
  exportIssues,
} from "./export.js";
import { REPORT_FILENAME, buildConsultantReport } from "./report.js";
import type { CoverageEntry } from "./coverage.js";
import type { StoredIssue } from "./issues.js";
import {
  isTokenFlag,
  missingRoles,
  probeLocalCredentials,
  TOKEN_FLAG_MESSAGE,
  type CredentialProbe,
  type RoleGap,
} from "./cli-credentials.js";
import { ScanRunner, providerFor, unconfiguredHarvester } from "./lib.js";
import { asMutable } from "./readonly.js";
import { assertNoSecrets } from "./secrets.js";
import { MemoryStore } from "./store.js";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export const CLI_ORG_ID = "local";

export const DEFAULT_WORKSPACE_DIRNAME = "farside-engagements";

export const ROLE_LISTING_CLOSER = "Live role listing is leftover (#55 / #192)";

export const USAGE = `Usage:
  farside connect --cloud <azure|gcp> [--workspace <dir>] [--fixture]
  farside scan --cloud <azure|gcp> --scope <id> [--workspace <dir>] [--fixture]
  farside findings [--workspace <dir>]
  farside export [--workspace <dir>]
  farside report [--workspace <dir>]
`;

const COMMANDS = ["connect", "scan", "findings", "export", "report"] as const;
type Command = (typeof COMMANDS)[number];

const WORKSPACE_FILES = {
  connect: "connect.json",
  findings: "findings.json",
  inventory: "inventory.json",
  coverage: "coverage.json",
  issues: "issues.json",
  cost: "cost.json",
  state: "state.json",
} as const;

/**
 * Cross-scan workspace state. A scan restores it into a fresh store, so a scan of a
 * second cloud keeps the first cloud's findings and scan ids keep counting.
 */
export type WorkspaceState = {
  version: 1;
  scans: Array<{ id: string; cloud: Cloud; scope: string; status: string; finishedAt: string | null }>;
  inventories: Partial<Record<Cloud, Inventory>>;
  costs: Record<string, CostSnapshot>;
};

function emptyState(): WorkspaceState {
  return { version: 1, scans: [], inventories: {}, costs: {} };
}

function readOptional<T>(dir: string, name: string): T | null {
  return existsSync(join(dir, name)) ? readWorkspaceFile<T>(dir, name) : null;
}

/** Reads state.json, or rebuilds it from a workspace written before state.json existed (one scan, scan-1). */
export function readWorkspaceState(dir: string): WorkspaceState {
  const saved = readOptional<WorkspaceState>(dir, WORKSPACE_FILES.state);
  if (saved) {
    return { ...emptyState(), ...saved };
  }
  const state = emptyState();
  const inventory = readOptional<Inventory | null>(dir, WORKSPACE_FILES.inventory);
  if (inventory) {
    state.inventories[inventory.cloud] = inventory;
    state.scans.push({ id: "scan-1", cloud: inventory.cloud, scope: "", status: "succeeded", finishedAt: null });
  }
  return state;
}

async function restoreWorkspace(store: MemoryStore, dir: string, state: WorkspaceState): Promise<void> {
  for (let index = 0; index < state.scans.length; index += 1) {
    await store.nextSequence(CLI_ORG_ID, "scan");
  }
  for (const inventory of Object.values(state.inventories)) {
    await store.putInventory(CLI_ORG_ID, inventory);
  }
  for (const [subscriptionId, cost] of Object.entries(state.costs)) {
    await store.putCost(CLI_ORG_ID, cost, subscriptionId);
  }
  await store.putFindings(CLI_ORG_ID, readOptional<Finding[]>(dir, WORKSPACE_FILES.findings) ?? []);
  await store.putCoverage(CLI_ORG_ID, readOptional<CoverageEntry[]>(dir, WORKSPACE_FILES.coverage) ?? []);
  await store.putIssues(CLI_ORG_ID, readOptional<StoredIssue[]>(dir, WORKSPACE_FILES.issues) ?? []);
}

export function defaultWorkspaceDir(home = homedir()): string {
  return join(home, DEFAULT_WORKSPACE_DIRNAME);
}

export type CliIo = {
  clock?: Clock;
  stdout?: { write: (chunk: string) => void };
  stderr?: { write: (chunk: string) => void };
  env?: NodeJS.Dict<string>;
  probe?: (cloud: Cloud) => CredentialProbe;
  grantedRoles?: readonly string[];
};

type Flags = {
  command?: Command;
  cloud?: Cloud;
  scope?: string;
  workspace?: string;
  fixture: boolean;
};

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

function isCloud(value: string): value is Cloud {
  return (CLOUDS as readonly string[]).includes(value);
}

function parseArgv(argv: string[]): { flags?: Flags; error?: string; help?: boolean } {
  const flags: Flags = { fixture: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    if (arg === "--fixture") {
      flags.fixture = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      let value = eq === -1 ? undefined : arg.slice(eq + 1);
      if (value === undefined) {
        const next = argv[index + 1];
        if (!next || next.startsWith("--")) {
          return { error: `missing value for --${key}` };
        }
        value = next;
        index += 1;
      }
      if (key === "cloud") {
        if (!isCloud(value)) {
          return { error: "cloud must be azure or gcp" };
        }
        flags.cloud = value;
        continue;
      }
      if (key === "scope" || key === "workspace") {
        flags[key] = value;
        continue;
      }
      if (isTokenFlag(key)) {
        return { error: TOKEN_FLAG_MESSAGE };
      }
      return { error: `unknown option --${key}` };
    }
    if (flags.command) {
      return { error: `unexpected argument '${arg}'` };
    }
    if (!isCommand(arg)) {
      return { error: `unknown command '${arg}'` };
    }
    flags.command = arg;
  }
  return { flags };
}

function writeLine(stream: { write: (chunk: string) => void }, value: unknown): void {
  stream.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}

function writeWorkspaceFile(dir: string, name: string, value: unknown): void {
  assertNoSecrets(value);
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function readWorkspaceFile<T>(dir: string, name: string): T {
  return JSON.parse(readFileSync(join(dir, name), "utf8")) as T;
}

function resolveWorkspace(flags: Flags, io: CliIo): string {
  return flags.workspace ?? defaultWorkspaceDir(io.env?.HOME ?? homedir());
}

export type ConnectReport = {
  cloud: Cloud;
  workspace: string;
  credentials: CredentialProbe | { present: true; source: "fixture" };
  missingRoles: RoleGap[];
  expectedRoles?: RoleGap[];
  roleListing?: "checked" | "unverified" | "fixture";
  closer?: string;
};

function expectedRoleGaps(cloud: Cloud): RoleGap[] {
  return missingRoles(cloud, []);
}

function runConnect(flags: Flags, io: CliIo): number {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  if (!flags.cloud) {
    writeLine(stderr, USAGE.trimEnd());
    return EXIT_USAGE;
  }
  const dir = resolveWorkspace(flags, io);
  mkdirSync(dir, { recursive: true });
  if (flags.fixture) {
    const report: ConnectReport = {
      cloud: flags.cloud,
      workspace: dir,
      credentials: { present: true, source: "fixture" },
      missingRoles: [],
      roleListing: "fixture",
    };
    writeWorkspaceFile(dir, WORKSPACE_FILES.connect, report);
    writeLine(stdout, report);
    return EXIT_OK;
  }
  const probe = io.probe?.(flags.cloud) ?? probeLocalCredentials(flags.cloud, io.env ?? process.env);
  const granted = io.grantedRoles;
  const report: ConnectReport =
    granted === undefined
      ? {
          cloud: flags.cloud,
          workspace: dir,
          credentials: probe,
          missingRoles: probe.present ? [] : expectedRoleGaps(flags.cloud),
          expectedRoles: expectedRoleGaps(flags.cloud),
          roleListing: "unverified",
          closer: ROLE_LISTING_CLOSER,
        }
      : {
          cloud: flags.cloud,
          workspace: dir,
          credentials: probe,
          missingRoles: missingRoles(flags.cloud, granted),
          roleListing: "checked",
        };
  writeWorkspaceFile(dir, WORKSPACE_FILES.connect, report);
  writeLine(stdout, report);
  if (!probe.present || report.missingRoles.some((gap) => gap.required)) {
    return EXIT_FAILED;
  }
  return EXIT_OK;
}

async function runScan(flags: Flags, io: CliIo): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  if (!flags.cloud || !flags.scope) {
    writeLine(stderr, USAGE.trimEnd());
    return EXIT_USAGE;
  }
  const dir = resolveWorkspace(flags, io);
  const clock = io.clock ?? systemClock;
  if (!flags.fixture) {
    const probe = io.probe?.(flags.cloud) ?? probeLocalCredentials(flags.cloud, io.env ?? process.env);
    if (!probe.present) {
      writeLine(stderr, probe.error ?? "signed-in Azure CLI / DefaultAzureCredential or GCP Application Default Credentials required");
      return EXIT_FAILED;
    }
    const gaps = missingRoles(flags.cloud, io.grantedRoles ?? []);
    if (gaps.length > 0) {
      writeLine(stderr, { missingRoles: gaps });
    }
  }
  const store = new MemoryStore(clock);
  const state = readWorkspaceState(dir);
  await restoreWorkspace(store, dir, state);
  const harvester = flags.fixture ? providerFor(flags.cloud).harvester(clock) : unconfiguredHarvester();
  const runner = new ScanRunner(
    store,
    harvester,
    flags.fixture
      ? {
          costClient: fixtureCostClient(),
          commitmentClient: fixtureCommitmentClient(),
          budgetClient: fixtureBudgetClient(),
        }
      : {},
    clock,
  );
  const { done } = await runner.start({
    orgId: CLI_ORG_ID,
    subscriptionId: flags.scope,
    actor: "user",
  });
  const job = await done;
  if (job.status !== "succeeded") {
    writeLine(stderr, job.error ?? "scan failed");
    return EXIT_FAILED;
  }
  const org = await store.read(
    CLI_ORG_ID,
    "findings",
    "inventories",
    "inventory",
    "coverage",
    "issues",
    "cost",
    "costs",
  );
  const inventory = org.inventories[flags.cloud] ?? org.inventory;
  const nextState: WorkspaceState = {
    version: 1,
    scans: [
      ...state.scans,
      { id: job.id, cloud: flags.cloud, scope: flags.scope, status: job.status, finishedAt: job.finishedAt ?? null },
    ],
    inventories: asMutable<WorkspaceState["inventories"]>(org.inventories),
    costs: asMutable<WorkspaceState["costs"]>(org.costs),
  };
  mkdirSync(dir, { recursive: true });
  writeWorkspaceFile(dir, WORKSPACE_FILES.state, nextState);
  writeWorkspaceFile(dir, WORKSPACE_FILES.findings, asMutable(org.findings));
  writeWorkspaceFile(dir, WORKSPACE_FILES.inventory, asMutable(inventory));
  writeWorkspaceFile(dir, WORKSPACE_FILES.coverage, asMutable(org.coverage));
  writeWorkspaceFile(dir, WORKSPACE_FILES.issues, asMutable(org.issues));
  writeWorkspaceFile(dir, WORKSPACE_FILES.cost, asMutable(org.cost));
  writeLine(stdout, {
    status: job.status,
    scanId: job.id,
    cloud: flags.cloud,
    scope: flags.scope,
    coverageSummary: job.coverageSummary,
  });
  return EXIT_OK;
}

function runFindings(flags: Flags, io: CliIo): number {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const dir = resolveWorkspace(flags, io);
  try {
    const findings = readWorkspaceFile<Finding[]>(dir, WORKSPACE_FILES.findings);
    assertNoSecrets(findings);
    writeLine(stdout, findings);
    return EXIT_OK;
  } catch (error) {
    writeLine(stderr, error instanceof Error ? error.message : "findings failed");
    return EXIT_FAILED;
  }
}

function writeExportFiles(dir: string, exportedAt: string) {
  const issues = readWorkspaceFile<StoredIssue[]>(dir, WORKSPACE_FILES.issues);
  const inventory = readWorkspaceFile<Inventory | null>(dir, WORKSPACE_FILES.inventory);
  const cost = readWorkspaceFile<CostSnapshot | null>(dir, WORKSPACE_FILES.cost);
  const saved = Object.values(readWorkspaceState(dir).inventories);
  const inventories = saved.length > 0 ? saved : inventory ? [inventory] : [];
  assertNoSecrets({ issues, inventories, cost });
  const inventoryEnvelope = exportInventory(CLI_ORG_ID, null, exportedAt);
  inventoryEnvelope.rows = inventories.flatMap(
    (item) => exportInventory(CLI_ORG_ID, item, exportedAt).rows as ExportInventoryRow[],
  );
  const envelopes = [
    exportIssues(CLI_ORG_ID, issues, exportedAt),
    inventoryEnvelope,
    exportCost(CLI_ORG_ID, cost, exportedAt),
  ];
  mkdirSync(dir, { recursive: true });
  for (const envelope of envelopes) {
    if (envelope.format !== EXPORT_FORMAT) {
      throw new Error("export format drifted");
    }
    writeWorkspaceFile(dir, exportFilename(envelope.kind), envelope);
  }
  return { issues, inventory, cost, envelopes };
}

function runExport(flags: Flags, io: CliIo): number {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const dir = resolveWorkspace(flags, io);
  const clock = io.clock ?? systemClock;
  try {
    const { envelopes } = writeExportFiles(dir, clock());
    writeLine(
      stdout,
      envelopes.map((envelope) => exportFilename(envelope.kind)),
    );
    return EXIT_OK;
  } catch (error) {
    writeLine(stderr, error instanceof Error ? error.message : "export failed");
    return EXIT_FAILED;
  }
}

function runReport(flags: Flags, io: CliIo): number {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const dir = resolveWorkspace(flags, io);
  const clock = io.clock ?? systemClock;
  try {
    const exportedAt = clock();
    const { issues, cost, envelopes } = writeExportFiles(dir, exportedAt);
    const findings = readWorkspaceFile<Finding[]>(dir, WORKSPACE_FILES.findings);
    const coverage = readWorkspaceFile<CoverageEntry[]>(dir, WORKSPACE_FILES.coverage);
    const exportedIssues = envelopes.find((envelope) => envelope.kind === "issues");
    const exportedCost = envelopes.find((envelope) => envelope.kind === "cost");
    if (!exportedIssues || !exportedCost) {
      writeLine(stderr, "export format drifted");
      return EXIT_FAILED;
    }
    const html = buildConsultantReport({
      issues,
      findings,
      coverage,
      cost,
      exportedIssues,
      exportedCost,
      now: exportedAt,
    });
    assertNoSecrets(html);
    writeFileSync(join(dir, REPORT_FILENAME), html);
    writeLine(stdout, { report: join(dir, REPORT_FILENAME) });
    return EXIT_OK;
  } catch (error) {
    writeLine(stderr, error instanceof Error ? error.message : "report failed");
    return EXIT_FAILED;
  }
}

export async function runCli(argv: string[], io: CliIo = {}): Promise<number> {
  const stderr = io.stderr ?? process.stderr;
  const parsed = parseArgv(argv);
  if (parsed.help) {
    writeLine(io.stdout ?? process.stdout, USAGE.trimEnd());
    return EXIT_OK;
  }
  if (parsed.error || !parsed.flags?.command) {
    writeLine(stderr, parsed.error ?? USAGE.trimEnd());
    return EXIT_USAGE;
  }
  if (parsed.flags.command === "connect") {
    return runConnect(parsed.flags, io);
  }
  if (parsed.flags.command === "scan") {
    return runScan(parsed.flags, io);
  }
  if (parsed.flags.command === "findings") {
    return runFindings(parsed.flags, io);
  }
  if (parsed.flags.command === "export") {
    return runExport(parsed.flags, io);
  }
  return runReport(parsed.flags, io);
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  // import.meta.url is the resolved path; argv[1] keeps symlinks (macOS /var -> /private/var).
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exit(await runCli(process.argv.slice(2)));
}
