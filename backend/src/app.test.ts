import { afterAll, describe, expect, it } from "vitest";
import { buildApp, SERVICE_NAME } from "./app.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";

const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };

describe("health route", () => {
  const app = buildApp();

  afterAll(async () => {
    await app.close();
  });

  it("returns ok for GET /health", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: SERVICE_NAME });
  });

  it("does not expose a catch-all", async () => {
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(404);
  });

  it("accepts PUT with a JSON body", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/settings",
      headers: ORG,
      payload: {
        ownerTagKey: "owner",
        productionTagKey: "environment",
        productionTagValue: "prod",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().ownerTagKey).toBe("owner");
  });

  it("reads a query string", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/coverage?cloud=azure",
      headers: ORG,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty("entries");
  });
});
