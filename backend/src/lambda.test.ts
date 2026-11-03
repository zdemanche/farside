import { describe, expect, it } from "vitest";
import { handler } from "./lambda.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";

const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };

describe("lambda handler", () => {
  it("serves /health", async () => {
    const result = await handler({ rawPath: "/health" });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ status: "ok", service: "farside" });
  });

  it("forwards PUT with a body", async () => {
    const result = await handler({
      rawPath: "/v1/orgs/org-a/settings",
      requestContext: { http: { method: "PUT" } },
      headers: { ...ORG, "content-type": "application/json" },
      body: JSON.stringify({
        ownerTagKey: "cost-center",
        productionTagKey: "environment",
        productionTagValue: "prod",
      }),
    });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).ownerTagKey).toBe("cost-center");
  });

  it("forwards a query string", async () => {
    const result = await handler({
      rawPath: "/v1/orgs/org-a/coverage",
      rawQueryString: "cloud=gcp",
      headers: ORG,
    });
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as { entries: Array<{ cloud?: string }> };
    expect(body.entries.every((entry) => entry.cloud === "gcp" || entry.cloud === undefined)).toBe(
      true,
    );
  });

  it("returns 404 for an unknown route", async () => {
    const result = await handler({ rawPath: "/nope" });
    expect(result.statusCode).toBe(404);
  });
});
