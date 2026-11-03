import { buildApp } from "./app.js";
import { systemClock } from "./clock.js";
import { pino } from "pino";
import { loggerFromEnv, pinoOptions } from "./observability.js";
import { storeFromEnv } from "./store-from-env.js";

type HttpMethod = "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";

export type ProxyEvent = {
  rawPath?: string;
  path?: string;
  rawQueryString?: string;
  httpMethod?: string;
  requestContext?: { http?: { method?: string } };
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string | null;
  isBase64Encoded?: boolean;
};

export type ProxyResult = {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: string[];
  body: string;
  isBase64Encoded: boolean;
};

const METHODS = new Set<HttpMethod>(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
const SESSION_HEADER_PREFIX = "x-farside-";
const TEXT_TYPE = /^(text\/|application\/(json|problem\+json|javascript|xml)|.*\+(json|xml))/i;

type ParameterReader = (name: string) => Promise<string | undefined>;

const readSsmParameter: ParameterReader = async (name) => {
  const { GetParameterCommand, SSMClient } = await import("@aws-sdk/client-ssm");
  const result = await new SSMClient({}).send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  return result.Parameter?.Value;
};

export async function resolveOperatorToken(
  env: NodeJS.ProcessEnv = process.env,
  read: ParameterReader = readSsmParameter,
): Promise<string | undefined> {
  const param = env.FARSIDE_OPERATOR_TOKEN_PARAM;
  if (!param) {
    return env.FARSIDE_OPERATOR_TOKEN || undefined;
  }
  const value = await read(param);
  if (!value) {
    throw new Error("operator token parameter is empty or unreadable");
  }
  return value;
}

async function start() {
  const app = buildApp(await storeFromEnv(process.env, systemClock, pino(pinoOptions(loggerFromEnv()) || {})), {
    operatorToken: await resolveOperatorToken(),
    logger: loggerFromEnv(),
  });
  await app.ready();
  return app;
}

let starting: ReturnType<typeof start> | undefined;

function appReady() {
  starting ??= start().catch((error: unknown) => {
    starting = undefined;
    throw error;
  });
  return starting;
}

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

function headersOf(event: ProxyEvent): Record<string, string> {
  const trustEdge = process.env.FARSIDE_TRUST_EDGE_HEADERS === "1";
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    const name = key.toLowerCase();
    if (value !== undefined && (trustEdge || !name.startsWith(SESSION_HEADER_PREFIX))) {
      headers[name] = value;
    }
  }
  if (event.cookies?.length) {
    headers.cookie = event.cookies.join("; ");
  }
  return headers;
}

function payloadOf(event: ProxyEvent): Buffer | string | undefined {
  if (!event.body) {
    return undefined;
  }
  return event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body;
}

export async function handler(event: ProxyEvent): Promise<ProxyResult> {
  const app = await appReady();
  const payload = payloadOf(event);
  const response = await app.inject({
    method: methodOf(event),
    url: urlOf(event),
    headers: headersOf(event),
    ...(payload === undefined ? {} : { payload }),
  });
  return resultOf(response);
}

type InjectedResponse = {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
  rawPayload: Buffer;
};

export function resultOf(response: InjectedResponse): ProxyResult {
  const headers: Record<string, string> = {};
  let cookies: string[] | undefined;
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined || name === "content-length" || name === "transfer-encoding") {
      continue;
    }
    if (name === "set-cookie") {
      cookies = Array.isArray(value) ? value.map(String) : [String(value)];
    } else {
      headers[name] = Array.isArray(value) ? value.map(String).join(", ") : String(value);
    }
  }
  const binary = !TEXT_TYPE.test(String(response.headers["content-type"] ?? "text/plain"));
  return {
    statusCode: response.statusCode,
    headers,
    ...(cookies ? { cookies } : {}),
    body: binary ? response.rawPayload.toString("base64") : response.body,
    isBase64Encoded: binary,
  };
}
