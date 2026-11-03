import { buildApp } from "./app.js";
import { loggerFromEnv } from "./observability.js";

type HttpMethod = "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";

export type ProxyEvent = {
  rawPath?: string;
  path?: string;
  rawQueryString?: string;
  httpMethod?: string;
  requestContext?: { http?: { method?: string } };
  headers?: Record<string, string | undefined>;
  body?: string | null;
};

type ProxyResult = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

const METHODS = new Set<HttpMethod>(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);

const app = buildApp(undefined, {
  operatorToken: process.env.FARSIDE_OPERATOR_TOKEN || undefined,
  logger: loggerFromEnv(),
});
const ready = app.ready();

function methodOf(event: ProxyEvent): HttpMethod {
  const raw = event.requestContext?.http?.method ?? event.httpMethod ?? "GET";
  const method = raw.toUpperCase();
  return METHODS.has(method as HttpMethod) ? (method as HttpMethod) : "GET";
}

function urlOf(event: ProxyEvent): string {
  const path = event.rawPath ?? event.path ?? "/health";
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  return `${path}${query}`;
}

export async function handler(event: ProxyEvent): Promise<ProxyResult> {
  await ready;
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) {
      headers[key] = value;
    }
  }
  const response = await app.inject({
    method: methodOf(event),
    url: urlOf(event),
    headers,
    ...(event.body ? { payload: event.body } : {}),
  });
  return {
    statusCode: response.statusCode,
    headers: { "content-type": "application/json" },
    body: response.body,
  };
}
