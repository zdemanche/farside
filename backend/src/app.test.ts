import { afterAll, describe, expect, it } from "vitest";
import { buildApp, SERVICE_NAME } from "./app.js";

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
});
