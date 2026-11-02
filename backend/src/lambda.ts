import { buildApp } from "./app.js";

type ProxyEvent = {
  rawPath?: string;
  path?: string;
};

type ProxyResult = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

const app = buildApp();
const ready = app.ready();

export async function handler(event: ProxyEvent): Promise<ProxyResult> {
  await ready;
  const url = event.rawPath ?? event.path ?? "/health";
  const response = await app.inject({ method: "GET", url });
  return {
    statusCode: response.statusCode,
    headers: { "content-type": "application/json" },
    body: response.body,
  };
}
