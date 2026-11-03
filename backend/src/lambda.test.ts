import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { handler, resolveOperatorToken, resultOf } from "./lambda.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";

const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };
const SETTINGS = {
  ownerTagKey: "cost-center",
  productionTagKey: "environment",
  productionTagValue: "prod",
};

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-03T00:00:00Z") }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("lambda handler", () => {
  it("serves /health", async () => {
    const result = await handler({ rawPath: "/health" });
    expect(result.statusCode).toBe(200);
    expect(result.isBase64Encoded).toBe(false);
    expect(JSON.parse(result.body)).toEqual({ status: "ok", service: "farside" });
  });

  it("matches app.inject for a PUT with headers and a JSON body", async () => {
    vi.stubEnv("FARSIDE_TRUST_EDGE_HEADERS", "1");
    const headers = { ...ORG, "content-type": "application/json" };
    const result = await handler({
      rawPath: "/v1/orgs/org-a/settings",
      requestContext: { http: { method: "PUT" } },
      headers,
      body: JSON.stringify(SETTINGS),
    });
    const direct = await buildApp().inject({
      method: "PUT",
      url: "/v1/orgs/org-a/settings",
      headers,
      payload: SETTINGS,
    });
    expect(result.statusCode).toBe(direct.statusCode);
    expect(JSON.parse(result.body)).toEqual(direct.json());
    expect(result.headers["content-type"]).toBe(direct.headers["content-type"]);
  });

  it("forwards a query string", async () => {
    vi.stubEnv("FARSIDE_TRUST_EDGE_HEADERS", "1");
    const result = await handler({
      rawPath: "/v1/orgs/org-a/coverage",
      rawQueryString: "cloud=gcp",
      headers: ORG,
    });
    const direct = await buildApp().inject({
      method: "GET",
      url: "/v1/orgs/org-a/coverage?cloud=gcp",
      headers: ORG,
    });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual(direct.json());
  });

  it("decodes a base64 request body and joins cookies", async () => {
    vi.stubEnv("FARSIDE_TRUST_EDGE_HEADERS", "1");
    const result = await handler({
      rawPath: "/v1/orgs/org-a/settings",
      requestContext: { http: { method: "PUT" } },
      headers: { ...ORG, "content-type": "application/json" },
      cookies: ["a=1", "b=2"],
      body: Buffer.from(JSON.stringify(SETTINGS)).toString("base64"),
      isBase64Encoded: true,
    });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).ownerTagKey).toBe("cost-center");
  });

  it("returns an empty body for a 204", async () => {
    vi.stubEnv("FARSIDE_TRUST_EDGE_HEADERS", "1");
    const created = await handler({
      rawPath: "/v1/orgs/org-204/connections",
      requestContext: { http: { method: "PUT" } },
      headers: {
        [ORG_HEADER]: "org-204",
        [ACTOR_HEADER]: "actor-a",
        "content-type": "application/json",
      },
      body: JSON.stringify({ tenantId: "t", subscriptionId: "s" }),
    });
    const connection = JSON.parse(created.body) as { id: string };
    const result = await handler({
      rawPath: `/v1/orgs/org-204/connections/${connection.id}`,
      requestContext: { http: { method: "DELETE" } },
      headers: { [ORG_HEADER]: "org-204", [ACTOR_HEADER]: "actor-a" },
    });
    expect(result.statusCode).toBe(204);
    expect(result.body).toBe("");
  });

  it("strips x-farside session headers unless the edge is trusted", async () => {
    const request = { rawPath: "/v1/orgs/org-a/coverage", headers: ORG };
    expect((await handler(request)).statusCode).toBe(401);
    vi.stubEnv("FARSIDE_TRUST_EDGE_HEADERS", "1");
    expect((await handler(request)).statusCode).toBe(200);
  });

  it("strips session headers by prefix in any case", async () => {
    const request = {
      rawPath: "/v1/orgs/org-a/coverage",
      headers: { "X-Farside-Org": "org-a", "X-Farside-Actor": "actor-a", "x-farside-role": "owner" },
    };
    expect((await handler(request)).statusCode).toBe(401);
    vi.stubEnv("FARSIDE_TRUST_EDGE_HEADERS", "1");
    expect((await handler(request)).statusCode).toBe(200);
  });

  it("returns 404 for an unknown route", async () => {
    const result = await handler({ rawPath: "/nope" });
    expect(result.statusCode).toBe(404);
  });
});

describe("resultOf", () => {
  it("base64-encodes a binary body", () => {
    const rawPayload = Buffer.from([0, 255, 1, 2]);
    const result = resultOf({
      statusCode: 200,
      headers: { "content-type": "application/octet-stream", "content-length": "4" },
      body: rawPayload.toString("utf8"),
      rawPayload,
    });
    expect(result.isBase64Encoded).toBe(true);
    expect(Buffer.from(result.body, "base64")).toEqual(rawPayload);
    expect(result.headers["content-length"]).toBeUndefined();
  });

  it("moves set-cookie to cookies and joins other multi-value headers", () => {
    const result = resultOf({
      statusCode: 200,
      headers: { "set-cookie": ["a=1", "b=2"], vary: ["origin", "accept"], "content-type": "application/json" },
      body: "{}",
      rawPayload: Buffer.from("{}"),
    });
    expect(result.cookies).toEqual(["a=1", "b=2"]);
    expect(result.headers.vary).toBe("origin, accept");
    expect(result.headers["set-cookie"]).toBeUndefined();
  });
});

describe("resolveOperatorToken", () => {
  it("reads the SecureString parameter named in the environment", async () => {
    const read = vi.fn(async () => "from-ssm");
    const token = await resolveOperatorToken(
      { FARSIDE_OPERATOR_TOKEN_PARAM: "/farside/operator-token", FARSIDE_OPERATOR_TOKEN: "local" },
      read,
    );
    expect(token).toBe("from-ssm");
    expect(read).toHaveBeenCalledWith("/farside/operator-token");
  });

  it("fails closed when the parameter is unreadable or empty", async () => {
    const env = { FARSIDE_OPERATOR_TOKEN_PARAM: "/farside/operator-token" };
    await expect(resolveOperatorToken(env, async () => undefined)).rejects.toThrow("unreadable");
    await expect(
      resolveOperatorToken(env, async () => {
        throw new Error("AccessDenied");
      }),
    ).rejects.toThrow("AccessDenied");
  });

  it("falls back to FARSIDE_OPERATOR_TOKEN for local runs", async () => {
    expect(await resolveOperatorToken({ FARSIDE_OPERATOR_TOKEN: "local" })).toBe("local");
    expect(await resolveOperatorToken({})).toBeUndefined();
  });
});
