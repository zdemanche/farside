import type { Finding } from "@farside/scan-contracts";
import { DataError, errorFromStatus, toDataError } from "./error";
import { formatEvidence, toMoney, lifecycleFrom, recoveryFrom } from "./derive";
import type {
  BlindSpot,
  ConnectInput,
  ConnectResult,
  CostWasteView,
  DataSource,
  EstateOverview,
  InventoryRow,
  IssueRow,
  IssueStatus,
  OrgSettings,
  ScanRow,
} from "./types";

const ORG_HEADER = "x-farside-org";

type StoredIssue = {
  id: string;
  checkId: string;
  resourceId: string;
  subscriptionOrProject: string;
  status: IssueStatus;
  evidence: Finding["evidence"]["fields"];
  savings?: { min: string; max: string; currency: string };
  coverage: string;
  firstSeen: string;
  lastConfirmed: string;
  closingScanId?: string;
  notConfirmedReason?: string;
};

type ApiOptions = {
  baseUrl: string;
  orgId: string;
  fetch?: typeof fetch;
};

function issueRow(issue: StoredIssue): IssueRow {
  return {
    id: issue.id,
    checkId: issue.checkId,
    resourceId: issue.resourceId,
    subscription: issue.subscriptionOrProject,
    status: issue.status,
    evidence: formatEvidence(issue.evidence),
    savings: toMoney(issue.savings),
    coverage: issue.coverage,
    firstSeen: issue.firstSeen,
    lastConfirmed: issue.lastConfirmed,
    ...(issue.closingScanId ? { closingScanId: issue.closingScanId } : {}),
    ...(issue.notConfirmedReason ? { notConfirmedReason: issue.notConfirmedReason } : {}),
  };
}

export function apiSource({ baseUrl, orgId, fetch: fetchImpl }: ApiOptions): DataSource {
  const root = `${baseUrl.replace(/\/+$/, "")}/v1/orgs/${encodeURIComponent(orgId)}`;
  const call = fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  async function request<T>(
    method: "GET" | "PUT",
    path: string,
    signal?: AbortSignal,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await call(`${root}${path}`, {
        method,
        ...(signal ? { signal } : {}),
        headers: {
          accept: "application/json",
          [ORG_HEADER]: orgId,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      throw toDataError(error);
    }
    if (!response.ok) {
      const problem: { title?: string } | null = await response.json().catch(() => null);
      throw errorFromStatus(response.status, problem?.title ?? response.statusText);
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new DataError(
        "failed",
        response.status,
        "The Farside API returned an unreadable response",
      );
    }
  }

  const get = <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, signal);
  const findings = async (signal?: AbortSignal) =>
    (await get<{ findings: Finding[] }>("/findings", signal)).findings;

  return {
    mode: "api",
    orgId,
    exportFile: async (kind, signal) => {
      let response: Response;
      try {
        response = await call(`${root}/export/${kind}`, {
          method: "GET",
          ...(signal ? { signal } : {}),
          headers: { accept: "application/json", [ORG_HEADER]: orgId },
        });
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        throw toDataError(error);
      }
      if (!response.ok) {
        const problem: { title?: string } | null = await response.json().catch(() => null);
        throw errorFromStatus(response.status, problem?.title ?? response.statusText);
      }
      const named = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "");
      return { filename: named?.[1] ?? `farside-${kind}.json`, content: await response.text() };
    },
    overview: (signal) => get<EstateOverview>("/estate", signal),
    inventory: async (signal) => {
      try {
        return (await get<{ resources: InventoryRow[] }>("/inventory/browse", signal)).resources;
      } catch (error) {
        if (error instanceof DataError && error.kind === "not-found") {
          return [];
        }
        throw error;
      }
    },
    issues: async (signal) =>
      (await get<{ issues: StoredIssue[] }>("/issues", signal)).issues.map(issueRow),
    costWaste: (signal) => get<CostWasteView>("/cost-waste", signal),
    scans: async (signal) => (await get<{ scans: ScanRow[] }>("/scans", signal)).scans,
    scan: (id, signal) => get<ScanRow>(`/scans/${encodeURIComponent(id)}`, signal),
    blindSpots: async (signal) => {
      const view = await get<{
        spots: BlindSpot[];
        health: { assessedScopes: number; unassessedScopes: number };
        formula: string;
      }>("/blind-spots", signal);
      return {
        spots: view.spots,
        leftOut: view.health.unassessedScopes,
        total: view.health.assessedScopes + view.health.unassessedScopes,
        formula: view.formula,
      };
    },
    recovery: async (signal) => recoveryFrom(await findings(signal)),
    lifecycle: async (signal) => lifecycleFrom(await findings(signal), new Date().toISOString()),
    settings: (signal) => get<OrgSettings>("/settings", signal),
    saveSettings: (settings, signal) => request<OrgSettings>("PUT", "/settings", signal, settings),
    connect: async (input: ConnectInput, signal) => {
      const result = await request<{ scanStarted?: boolean; attention?: string }>(
        "PUT",
        "/connections",
        signal,
        input,
      );
      const connected: ConnectResult = {
        scanStarted: result.scanStarted === true,
        attention: result.attention ?? null,
      };
      return connected;
    },
  };
}
