import { describe, expect, it } from "vitest";
import { handler } from "./lambda.js";

describe("lambda handler", () => {
  it("serves /health", async () => {
    const result = await handler({ rawPath: "/health" });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ status: "ok", service: "farside" });
  });
});
