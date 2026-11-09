import type { Cloud, Finding } from "@farside/scan-contracts";
import { DataError, errorFromStatus, toDataError } from "./error";
import { formatEvidence, toMoney, lifecycleFrom, recoveryFrom } from "./derive";
import type {
  BillingView,
  BlindSpot,
  ClaimView,
  ConnectInput,
  ConnectResult,
  CostWasteView,
  DataSource,
  DeletionView,
  EstateOverview,
  Headline,
  InventoryRow,
  IssueRow,
  IssueStatus,
  OrgSettings,
  RoleGap,
  ScanRow,
} from "./types";

const ORG_HEADER = "x-farside-org";

type StoredIssue = {
  id: string;
  cloud?: Cloud;
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
  /** Limit every read to one cloud; omit for all clouds. */
  cloud?: Cloud;
  fetch?: typeof fetch;
  /** Bearer token from sign-in. When set it replaces the x-farside-org header stand-in. */
  token?: string;
};

function authHeaders(orgId: string, token: string | undefined): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : { [ORG_HEADER]: orgId };
}

function orgRoot(baseUrl: string, orgId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/orgs/${encodeURIComponent(orgId)}`;
}

async function sendJson<T>(
  call: typeof fetch,
  url: string,
  init: {
    method: "GET" | "PUT" | "POST";
    headers: Record<string, string>;
    signal?: AbortSignal;
    body?: unknown;
  },
): Promise<T> {
  let response: Response;
  try {
    response = await call(url, {
      method: init.method,
      ...(init.signal ? { signal: init.signal } : {}),
      headers: {
        accept: "application/json",
        ...init.headers,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (error) {
    if (init.signal?.aborted) {
      throw error;
    }
    throw toDataError(error);
  }
  if (!response.ok) {
    const problem: { title?: string; error?: string } | null = await response
      .json()
      .catch(() => null);
    throw errorFromStatus(response.status, problem?.title ?? response.statusText, problem?.error);
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

const defaultFetch = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);

/** The org claim API (#46): read the caller's membership, then claim or join the org. */
export function claimApi({ baseUrl, orgId, token, fetch: fetchImpl }: Omit<ApiOptions, "cloud">) {
  const url = `${orgRoot(baseUrl, orgId)}/claim`;
  const call = fetchImpl ?? defaultFetch;
  const headers = authHeaders(orgId, token);
  return {
    status: (signal?: AbortSignal) =>
      sendJson<ClaimView>(call, url, { method: "GET", headers, ...(signal ? { signal } : {}) }),
    claim: (signal?: AbortSignal) =>
      sendJson<ClaimView & { outcome: "claimed" | "joined" | "existing" }>(call, url, {
        method: "POST",
        headers,
        ...(signal ? { signal } : {}),
      }),
  };
}

function issueRow(issue: StoredIssue): IssueRow {
  return {
    id: issue.id,
    cloud: issue.cloud ?? "azure",
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

export function apiSource({
  baseUrl,
  orgId,
  cloud,
  fetch: fetchImpl,
  token,
}: ApiOptions): DataSource {
  const root = orgRoot(baseUrl, orgId);
  const query = cloud ? `?cloud=${encodeURIComponent(cloud)}` : "";
  const call = fetchImpl ?? defaultFetch;
  const headers = authHeaders(orgId, token);

  const request = <T>(
    method: "GET" | "PUT" | "POST",
    path: string,
    signal?: AbortSignal,
    body?: unknown,
  ): Promise<T> =>
    sendJson<T>(call, `${root}${path}${method === "GET" ? query : ""}`, {
      method,
      headers,
      ...(signal ? { signal } : {}),
      ...(body === undefined ? {} : { body }),
    });

  const get = <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, signal);
  const findings = async (signal?: AbortSignal) =>
    (await get<{ findings: Finding[] }>("/findings", signal)).findings;

  return {
    mode: "api",
    orgId,
    ...(cloud ? { cloud } : {}),
    exportFile: async (kind, signal, options) => {
      let response: Response;
      try {
        response = await call(`${root}/export/${kind}${options?.allClouds ? "" : query}`, {
          method: "GET",
          ...(signal ? { signal } : {}),
          headers: { accept: "application/json", ...headers },
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
      const named = /filename="([\w.-]+\.json)"/.exec(
        response.headers.get("content-disposition") ?? "",
      );
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
    headline: (signal) => get<Headline>("/headline", signal),
    billing: (signal) => get<BillingView>("/contract", signal),
    deletion: async (signal) => {
      try {
        return await get<DeletionView>("/deletion", signal);
      } catch (error) {
        if (error instanceof DataError && error.kind === "not-found") {
          return null;
        }
        throw error;
      }
    },
    offboard: (signal) =>
      request<DeletionView>("POST", "/offboard", signal, { confirm: true, exportOffered: true }),
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
      const result = await request<{ id?: string; scanStarted?: boolean; attention?: string }>(
        "PUT",
        "/connections",
        signal,
        input,
      );
      let roleGaps: RoleGap[] | null = null;
      if (result.id) {
        try {
          const probed = await request<{ missingRoles?: RoleGap[] }>(
            "POST",
            `/connections/${encodeURIComponent(result.id)}/roles`,
            signal,
          );
          roleGaps = probed.missingRoles ?? [];
        } catch (error) {
          if (signal?.aborted) {
            throw error;
          }
        }
      }
      const connected: ConnectResult = {
        scanStarted: result.scanStarted === true,
        attention: result.attention ?? null,
        roleGaps,
      };
      return connected;
    },
  };
}
