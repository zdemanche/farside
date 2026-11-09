import { CloudAssetThrottleError, type CloudAsset, type CloudAssetClient } from "./cloud-asset.js";
import type { BillingExportHarvest } from "./gcp-billing-export.js";
import {
  MissingBillingExportRoleError,
  type BigQueryExportClient,
  type GcpCostRow,
} from "./gcp-cost.js";
import type { GcpTokenProvider } from "./gcp-federation.js";
import { REC_TYPE, type GcpRecommendation } from "./gcp-recommender.js";

/**
 * Read-only GCP REST clients behind the injected harvest interfaces. Shapes follow Google's
 * public REST reference and have NOT been run against a live project: every use stays
 * unverified until a dated record exists under docs/gcp/live-runs/.
 *
 * The bearer token comes from an injected provider and is sent only to GCP_ORIGINS.
 */
export const GCP_ORIGINS = [
  "https://cloudasset.googleapis.com",
  "https://bigquery.googleapis.com",
  "https://recommender.googleapis.com",
  "https://sqladmin.googleapis.com",
  "https://container.googleapis.com",
  "https://certificatemanager.googleapis.com",
  "https://cloudresourcemanager.googleapis.com",
] as const;
export const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 3;
export const MAX_RETRY_WAIT_MS = 5_000;
const MAX_PAGES = 50;
const DAY_MS = 86_400_000;

export const SQL_ASSET_TYPE = "sqladmin.googleapis.com/Instance";
export const GKE_ASSET_TYPE = "container.googleapis.com/Cluster";
export const CERT_ASSET_TYPE = "certificatemanager.googleapis.com/Certificate";

/** Launch types Cloud Asset does not list; they come from their own API. */
export const NOT_IN_CLOUD_ASSET: ReadonlySet<string> = new Set([REC_TYPE]);

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type GcpOptions = {
  /** Called once per request, so it should cache (gcpFederatedTokenProvider does). */
  token: GcpTokenProvider;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

/** HTTP 403: the identity lacks a permission. */
export class GcpAccessDeniedError extends Error {
  constructor() {
    super("GCP refused the read (HTTP 403)");
    this.name = "GcpAccessDeniedError";
  }
}

/** HTTP 401: the token was rejected. Not a missing role. */
export class GcpAuthError extends Error {
  constructor() {
    super("GCP rejected the access token (HTTP 401)");
    this.name = "GcpAuthError";
  }
}

export class GcpApiError extends Error {
  constructor(readonly status: number) {
    super(`GCP returned HTTP ${status}`);
    this.name = "GcpApiError";
  }
}

export class GcpThrottledError extends Error {
  constructor() {
    super("GCP throttled the read after retries");
    this.name = "GcpThrottledError";
  }
}

export class MissingRecommenderRoleError extends Error {
  constructor() {
    super("Recommender Viewer is missing");
    this.name = "MissingRecommenderRoleError";
  }
}

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const LOCATION = /^[a-z0-9-]{1,40}$/;
const RECOMMENDER_ID = /^google\.[A-Za-z0-9.]{1,100}$/;
const TABLE = /^([a-z][a-z0-9-]{4,28}[a-z0-9])\.([A-Za-z0-9_]{1,1024})\.([A-Za-z0-9_]{1,1024})$/;

export function safeProjectId(projectId: string): string {
  if (!PROJECT_ID.test(projectId)) {
    throw new Error("not a GCP project id");
  }
  return projectId;
}

function safeLocation(location: string): string {
  if (!LOCATION.test(location)) {
    throw new Error("not a GCP location");
  }
  return location;
}

export function parseBillingTable(table: string): {
  project: string;
  dataset: string;
  table: string;
} {
  const match = TABLE.exec(table);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error("billing export table must be <project>.<dataset>.<table>");
  }
  return { project: match[1], dataset: match[2], table: match[3] };
}

function isGcpUrl(url: string): boolean {
  return GCP_ORIGINS.some((origin) => url.startsWith(`${origin}/`));
}

function nowOf(options: GcpOptions): Date {
  return (options.now ?? (() => new Date()))();
}

async function pause(options: GcpOptions, ms: number): Promise<void> {
  await (
    options.sleep ?? ((wait: number) => new Promise<void>((resolve) => setTimeout(resolve, wait)))
  )(ms);
}

function retryWait(response: Response, attempt: number): number {
  const header = Number(response.headers.get("retry-after"));
  const wait = Number.isFinite(header) && header > 0 ? header * 1000 : 500 * 2 ** attempt;
  return Math.min(wait, MAX_RETRY_WAIT_MS);
}

export async function gcpJson(
  options: GcpOptions,
  method: "GET" | "POST",
  url: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  // Checked before the token is requested, so a refused URL never touches the credential.
  if (!isGcpUrl(url)) {
    throw new Error("refusing to send credentials outside the GCP read APIs");
  }
  const call = options.fetch ?? ((input, init) => fetch(input, init));
  for (let attempt = 0; ; attempt += 1) {
    const response = await call(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${await options.token()}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401) {
      throw new GcpAuthError();
    }
    if (response.status === 403) {
      throw new GcpAccessDeniedError();
    }
    const throttled = response.status === 429 || response.status === 503;
    if (throttled) {
      if (attempt + 1 < MAX_ATTEMPTS) {
        await pause(options, retryWait(response, attempt));
        continue;
      }
      throw new GcpThrottledError();
    }
    if (!response.ok) {
      throw new GcpApiError(response.status);
    }
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new GcpApiError(502);
    }
    return parsed as Record<string, unknown>;
  }
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** int64 fields arrive as strings. */
function numeric(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

function lastSegment(value: string): string {
  return value.split("/").filter(Boolean).pop() ?? value;
}

function stringLabels(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(obj(value)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function wholeDaysBetween(from: number, to: number): number {
  return Math.floor((to - from) / DAY_MS);
}

function sizeGbFromBytes(bytes: unknown, fallbackGb: unknown): number | null {
  const raw = numeric(bytes);
  return raw !== null && raw > 0 ? Math.ceil(raw / 2 ** 30) : numeric(fallbackGb);
}

/** "1.30.5-gke.1014001" -> "1.30", matching docs/gcp/support-versions.json keys. */
export function gkeMinorVersion(version: string | null): string | null {
  const match = version ? /^(\d+\.\d+)/.exec(version) : null;
  return match?.[1] ?? null;
}

type Props = NonNullable<CloudAsset["properties"]>;

/** Maps a REST resource body onto the fact fields the GCP checks read. */
export function gcpProperties(assetType: string, data: Json, now: Date): Props {
  const users = Array.isArray(data.users) ? data.users.length : 0;
  const age = (stamp: unknown): number | null => {
    const parsed = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
    return Number.isFinite(parsed) ? wholeDaysBetween(parsed, now.getTime()) : null;
  };
  switch (assetType) {
    case "compute.googleapis.com/Disk":
      // Compute omits `users` on an unattached disk.
      return { usersCount: users, sizeGb: numeric(data.sizeGb) };
    case "compute.googleapis.com/Address":
      return {
        status: text(data.status),
        usersCount: users,
        address: text(data.address),
        addressType: text(data.addressType),
      };
    case "compute.googleapis.com/Snapshot":
      return {
        creationTimestamp: text(data.creationTimestamp),
        ageDays: age(data.creationTimestamp),
        sizeGb: sizeGbFromBytes(data.storageBytes, data.diskSizeGb),
      };
    case "compute.googleapis.com/Image":
      return {
        creationTimestamp: text(data.creationTimestamp),
        ageDays: age(data.creationTimestamp),
        sizeGb: sizeGbFromBytes(data.archiveSizeBytes, data.diskSizeGb),
      };
    case "compute.googleapis.com/Instance":
      return { status: text(data.status) };
    case SQL_ASSET_TYPE: {
      const settings = obj(data.settings);
      const backup = obj(settings.backupConfiguration).enabled;
      return {
        databaseVersion: text(data.databaseVersion),
        availabilityType: text(settings.availabilityType),
        backupEnabled: typeof backup === "boolean" ? backup : null,
      };
    }
    case GKE_ASSET_TYPE:
      return { currentMasterVersion: gkeMinorVersion(text(data.currentMasterVersion)) };
    case CERT_ASSET_TYPE: {
      const expireTime = text(data.expireTime);
      const expires = expireTime ? Date.parse(expireTime) : Number.NaN;
      return {
        expireTime,
        daysRemaining: Number.isFinite(expires) ? wholeDaysBetween(now.getTime(), expires) : null,
      };
    }
    default:
      return {};
  }
}

function labelsOf(assetType: string, data: Json): Record<string, string> {
  if (assetType === SQL_ASSET_TYPE) {
    return stringLabels(obj(data.settings).userLabels);
  }
  if (assetType === GKE_ASSET_TYPE) {
    return stringLabels(data.resourceLabels);
  }
  return stringLabels(data.labels);
}

function locationOf(data: Json, fallback: unknown): string {
  const raw = text(fallback) ?? text(data.location) ?? text(data.zone) ?? text(data.region);
  return raw ? lastSegment(raw) : "global";
}

export function assetFromResource(input: {
  name: string;
  assetType: string;
  projectId: string;
  data: Json;
  location?: unknown;
  now: Date;
}): CloudAsset {
  const id = lastSegment(input.name);
  return {
    id,
    name: input.name,
    assetType: input.assetType,
    project: input.projectId,
    displayName: id,
    location: locationOf(input.data, input.location),
    labels: labelsOf(input.assetType, input.data),
    properties: gcpProperties(input.assetType, input.data, input.now),
  };
}

const CLOUD_ASSET_PAGE_SIZE = "500";

export function liveCloudAssetClient(options: GcpOptions): CloudAssetClient {
  return {
    async list(input) {
      if (NOT_IN_CLOUD_ASSET.has(input.assetType)) {
        return { assets: [] };
      }
      const query = new URLSearchParams({
        assetTypes: input.assetType,
        contentType: "RESOURCE",
        pageSize: CLOUD_ASSET_PAGE_SIZE,
        ...(input.pageToken ? { pageToken: input.pageToken } : {}),
      });
      const url = `https://cloudasset.googleapis.com/v1/projects/${safeProjectId(input.projectId)}/assets?${query}`;
      let body: Json;
      try {
        body = await gcpJson(options, "GET", url);
      } catch (error) {
        if (error instanceof GcpThrottledError) {
          throw new CloudAssetThrottleError();
        }
        throw error;
      }
      const now = nowOf(options);
      const raw = Array.isArray(body.assets) ? body.assets : [];
      const assets = raw.flatMap((entry: unknown) => {
        const asset = obj(entry);
        const name = text(asset.name);
        if (!name) {
          return [];
        }
        const resource = obj(asset.resource);
        return [
          assetFromResource({
            name,
            assetType: text(asset.assetType) ?? input.assetType,
            projectId: input.projectId,
            data: obj(resource.data),
            location: resource.location,
            now,
          }),
        ];
      });
      const next = text(body.nextPageToken);
      return next ? { assets, pageToken: next } : { assets };
    },
  };
}

async function pagedList(options: GcpOptions, base: string, key: string): Promise<Json[]> {
  const items: Json[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url: string = pageToken
      ? `${base}${base.includes("?") ? "&" : "?"}pageToken=${encodeURIComponent(pageToken)}`
      : base;
    const body = await gcpJson(options, "GET", url);
    const list = body[key];
    items.push(...(Array.isArray(list) ? list.map(obj) : []));
    pageToken = text(body.nextPageToken);
    if (!pageToken) {
      return items;
    }
  }
  throw new Error("GCP list exceeded page limit");
}

/** Direct service reads that back the SQL, GKE and certificate checks. */
export type GcpServiceReads = {
  listSqlInstances: (projectId: string) => Promise<CloudAsset[]>;
  listGkeClusters: (projectId: string) => Promise<CloudAsset[]>;
  listCertificates: (projectId: string) => Promise<CloudAsset[]>;
};

export function liveServiceReads(
  options: GcpOptions & { certificateLocations?: readonly string[] },
): GcpServiceReads {
  const locations = options.certificateLocations ?? ["global"];
  return {
    async listSqlInstances(projectId) {
      const project = safeProjectId(projectId);
      const rows = await pagedList(
        options,
        `https://sqladmin.googleapis.com/v1/projects/${project}/instances`,
        "items",
      );
      const now = nowOf(options);
      return rows.flatMap((row) => {
        const name = text(row.name);
        return name
          ? [
              assetFromResource({
                name: `//cloudsql.googleapis.com/projects/${project}/instances/${name}`,
                assetType: SQL_ASSET_TYPE,
                projectId,
                data: row,
                location: row.region,
                now,
              }),
            ]
          : [];
      });
    },
    async listGkeClusters(projectId) {
      const project = safeProjectId(projectId);
      const body = await gcpJson(
        options,
        "GET",
        `https://container.googleapis.com/v1/projects/${project}/locations/-/clusters`,
      );
      const now = nowOf(options);
      const rows = Array.isArray(body.clusters) ? body.clusters.map(obj) : [];
      return rows.flatMap((row) => {
        const name = text(row.name);
        const location = text(row.location) ?? "global";
        return name
          ? [
              assetFromResource({
                name: `//container.googleapis.com/projects/${project}/locations/${location}/clusters/${name}`,
                assetType: GKE_ASSET_TYPE,
                projectId,
                data: row,
                location,
                now,
              }),
            ]
          : [];
      });
    },
    async listCertificates(projectId) {
      const project = safeProjectId(projectId);
      const now = nowOf(options);
      const out: CloudAsset[] = [];
      for (const location of locations) {
        const rows = await pagedList(
          options,
          `https://certificatemanager.googleapis.com/v1/projects/${project}/locations/${safeLocation(location)}/certificates`,
          "certificates",
        );
        for (const row of rows) {
          const name = text(row.name);
          if (name) {
            out.push(
              assetFromResource({
                name: `//certificatemanager.googleapis.com/${name}`,
                assetType: CERT_ASSET_TYPE,
                projectId,
                data: row,
                location,
                now,
              }),
            );
          }
        }
      }
      return out;
    },
  };
}

export const IDLE_RECOMMENDERS = [
  "google.compute.instance.IdleResourceRecommender",
  "google.compute.disk.IdleResourceRecommender",
] as const;

export type RecommenderClient = {
  list: (input: {
    projectId: string;
    location: string;
    recommenderId: string;
  }) => Promise<GcpRecommendation[]>;
};

/** `units` + `nanos` money; negative cost is a saving. */
function moneyAmount(value: unknown): number | null {
  const money = obj(value);
  const units = numeric(money.units) ?? 0;
  const nanos = numeric(money.nanos) ?? 0;
  if (money.units === undefined && money.nanos === undefined) {
    return null;
  }
  return units + nanos / 1e9;
}

/**
 * Recommender reports a single cost projection, not a range. It is kept as savingsMax only;
 * the check then says the range is missing (undetermined) rather than inventing a min.
 */
export function recommendationFrom(
  row: Json,
  projectId: string,
  recommenderId: string,
): GcpRecommendation | null {
  const name = text(row.name);
  if (!name) {
    return null;
  }
  const state = text(obj(row.stateInfo).state);
  if (state && state !== "ACTIVE") {
    return null;
  }
  const groups = Array.isArray(obj(row.content).operationGroups)
    ? (obj(row.content).operationGroups as unknown[])
    : [];
  const operations = groups.flatMap((group) => {
    const list = obj(group).operations;
    return Array.isArray(list) ? list.map(obj) : [];
  });
  const resourceName =
    operations.map((operation) => text(operation.resource)).find((value) => value !== null) ?? null;
  const cost = obj(obj(row.primaryImpact).costProjection).cost;
  const amount = moneyAmount(cost);
  const currency = text(obj(cost).currencyCode);
  return {
    recommendationId: lastSegment(name),
    recommenderId,
    resourceName: resourceName ?? name,
    subtype: text(row.recommenderSubtype) ?? "",
    projectId,
    ...(amount !== null && amount < 0 ? { savingsMax: Math.round(-amount * 100) / 100 } : {}),
    ...(currency ? { currency } : {}),
  };
}

export function liveRecommenderClient(options: GcpOptions): RecommenderClient {
  return {
    async list(input) {
      if (!RECOMMENDER_ID.test(input.recommenderId)) {
        throw new Error("not a recommender id");
      }
      const base = `https://recommender.googleapis.com/v1/projects/${safeProjectId(input.projectId)}/locations/${safeLocation(input.location)}/recommenders/${input.recommenderId}/recommendations`;
      let rows: Json[];
      try {
        rows = await pagedList(options, base, "recommendations");
      } catch (error) {
        if (error instanceof GcpAccessDeniedError) {
          throw new MissingRecommenderRoleError();
        }
        throw error;
      }
      return rows.flatMap((row) => {
        const rec = recommendationFrom(row, input.projectId, input.recommenderId);
        return rec ? [rec] : [];
      });
    },
  };
}

export const BILLING_EXPORT_DAYS = 92;
const QUERY_POLLS = 10;
const QUERY_POLL_MS = 1_000;

export function billingExportQuery(table: string): string {
  const { project, dataset, table: name } = parseBillingTable(table);
  return [
    "SELECT FORMAT_DATE('%Y-%m-%d', DATE(usage_start_time)) AS date,",
    "project.id AS projectId,",
    "service.description AS serviceName,",
    "FORMAT('%.2f', SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0))) AS costAmount,",
    "currency",
    `FROM \`${project}.${dataset}.${name}\``,
    "WHERE project.id = @projectId AND DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY)",
    "GROUP BY date, projectId, serviceName, currency",
    "ORDER BY date, serviceName",
  ].join(" ");
}

type PageCursor = { jobId: string; location: string; pageToken?: string };

function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(token: string): PageCursor {
  const parsed = obj(JSON.parse(Buffer.from(token, "base64url").toString("utf8")));
  const jobId = text(parsed.jobId);
  const location = text(parsed.location);
  if (
    !jobId ||
    !/^[A-Za-z0-9_-]{1,1024}$/.test(jobId) ||
    !location ||
    !LOCATION.test(location.toLowerCase())
  ) {
    throw new Error("not a BigQuery page cursor");
  }
  const pageToken = text(parsed.pageToken);
  return pageToken ? { jobId, location, pageToken } : { jobId, location };
}

async function runQuery(
  options: GcpOptions,
  jobProject: string,
  query: string,
  parameters: Array<{ name: string; type: "STRING" | "INT64"; value: string }>,
  cursor?: PageCursor,
): Promise<{ body: Json; cursor: PageCursor }> {
  const root = `https://bigquery.googleapis.com/bigquery/v2/projects/${safeProjectId(jobProject)}/queries`;
  const results = (at: PageCursor) => {
    const params = new URLSearchParams({
      location: at.location,
      maxResults: "1000",
      timeoutMs: "20000",
    });
    if (at.pageToken) {
      params.set("pageToken", at.pageToken);
    }
    return gcpJson(options, "GET", `${root}/${encodeURIComponent(at.jobId)}?${params}`);
  };
  let body = cursor
    ? await results(cursor)
    : await gcpJson(options, "POST", root, {
        query,
        useLegacySql: false,
        parameterMode: "NAMED",
        queryParameters: parameters.map((parameter) => ({
          name: parameter.name,
          parameterType: { type: parameter.type },
          parameterValue: { value: parameter.value },
        })),
        maxResults: 1000,
        timeoutMs: 20000,
      });
  const reference = obj(body.jobReference);
  const jobId = text(reference.jobId) ?? cursor?.jobId;
  const location = text(reference.location) ?? cursor?.location;
  if (!jobId || !location) {
    throw new GcpApiError(502);
  }
  for (let poll = 0; body.jobComplete === false; poll += 1) {
    if (poll >= QUERY_POLLS) {
      throw new GcpApiError(504);
    }
    await pause(options, QUERY_POLL_MS);
    body = await results({
      jobId,
      location,
      ...(cursor?.pageToken ? { pageToken: cursor.pageToken } : {}),
    });
  }
  return { body, cursor: { jobId, location } };
}

function cells(row: unknown): unknown[] {
  const fields = obj(row).f;
  return Array.isArray(fields) ? fields.map((cell) => obj(cell).v) : [];
}

/** The query window is fixed in the SQL relative to CURRENT_DATE(), so every page sees the same rows. */
export function liveBigQueryExportClient(
  options: GcpOptions & { table: string; jobProjectId: string; days?: number },
): BigQueryExportClient {
  const query = billingExportQuery(options.table);
  const days = options.days ?? BILLING_EXPORT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > 400) {
    throw new Error("billing export window must be 1 to 400 days");
  }
  return {
    async query(input) {
      safeProjectId(input.projectId);
      let result: { body: Json; cursor: PageCursor };
      try {
        result = await runQuery(
          options,
          options.jobProjectId,
          query,
          [
            { name: "projectId", type: "STRING", value: input.projectId },
            { name: "days", type: "INT64", value: String(days) },
          ],
          input.pageToken ? decodeCursor(input.pageToken) : undefined,
        );
      } catch (error) {
        if (error instanceof GcpAccessDeniedError) {
          throw new MissingBillingExportRoleError();
        }
        throw error;
      }
      const raw = Array.isArray(result.body.rows) ? result.body.rows : [];
      const rows: GcpCostRow[] = raw.map((row: unknown) => {
        const [date, projectId, serviceName, costAmount, currency] = cells(row);
        if (
          typeof date !== "string" ||
          typeof projectId !== "string" ||
          typeof serviceName !== "string" ||
          typeof costAmount !== "string" ||
          !/^-?\d+\.\d{2}$/.test(costAmount) ||
          typeof currency !== "string"
        ) {
          // A malformed amount must never become 0.00 in the books.
          throw new GcpApiError(502);
        }
        return { date, projectId, serviceName, costAmount, currency };
      });
      const next = text(result.body.pageToken);
      return next
        ? { rows, pageToken: encodeCursor({ ...result.cursor, pageToken: next }) }
        : { rows };
    },
  };
}

/** Reads export table state for detectBillingExport. 404 is absent; 403 is unreadable. */
export function liveBillingExportDetector(
  options: GcpOptions & { table: string; jobProjectId: string },
) {
  const { project, dataset, table } = parseBillingTable(options.table);
  return {
    async detect(): Promise<BillingExportHarvest> {
      let meta: Json;
      try {
        meta = await gcpJson(
          options,
          "GET",
          `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets/${dataset}/tables/${table}`,
        );
      } catch (error) {
        if (error instanceof GcpApiError && error.status === 404) {
          return { state: "absent" };
        }
        if (error instanceof GcpAccessDeniedError) {
          return { state: "unreadable" };
        }
        throw error;
      }
      const created = numeric(meta.creationTime);
      if (created === null) {
        throw new GcpApiError(502);
      }
      const enabledOn = new Date(created).toISOString().slice(0, 10);
      let body: Json;
      try {
        ({ body } = await runQuery(
          options,
          options.jobProjectId,
          `SELECT DISTINCT FORMAT_DATE('%Y-%m-%d', DATE(usage_start_time)) AS day FROM \`${project}.${dataset}.${table}\` WHERE DATE(usage_start_time) < CURRENT_DATE() ORDER BY day`,
          [],
        ));
      } catch (error) {
        if (error instanceof GcpAccessDeniedError) {
          return { state: "unreadable" };
        }
        throw error;
      }
      const rows = Array.isArray(body.rows) ? body.rows : [];
      const completedDays = rows
        .map((row) => cells(row)[0])
        .filter((day): day is string => typeof day === "string");
      return completedDays.length === 0
        ? { state: "empty", enabledOn }
        : { state: "readable", enabledOn, completedDays };
    },
  };
}

export type GcpPermissionTester = {
  project: (projectId: string, permissions: readonly string[]) => Promise<string[]>;
  table: (table: string, permissions: readonly string[]) => Promise<string[]>;
};

function grantedFrom(body: Json, asked: readonly string[]): string[] {
  const list = Array.isArray(body.permissions) ? body.permissions : [];
  const wanted = new Set(asked);
  return list.filter(
    (permission): permission is string => typeof permission === "string" && wanted.has(permission),
  );
}

/** testIamPermissions never fails for a missing permission; it returns the granted subset. */
export function liveGcpPermissionTester(options: GcpOptions): GcpPermissionTester {
  return {
    async project(projectId, permissions) {
      const body = await gcpJson(
        options,
        "POST",
        `https://cloudresourcemanager.googleapis.com/v1/projects/${safeProjectId(projectId)}:testIamPermissions`,
        { permissions },
      );
      return grantedFrom(body, permissions);
    },
    async table(tableName, permissions) {
      const { project, dataset, table } = parseBillingTable(tableName);
      try {
        const body = await gcpJson(
          options,
          "POST",
          `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets/${dataset}/tables/${table}:testIamPermissions`,
          { permissions },
        );
        return grantedFrom(body, permissions);
      } catch (error) {
        if (
          error instanceof GcpAccessDeniedError ||
          (error instanceof GcpApiError && error.status === 404)
        ) {
          return [];
        }
        throw error;
      }
    },
  };
}
