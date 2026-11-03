import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { ORG_HEADER, sessionFromHeaders } from "./session.js";

const requestWith = (orgId: string) => ({ headers: { [ORG_HEADER]: orgId } }) as unknown as FastifyRequest;

describe("session org header", () => {
  it("accepts the same ids the org route parameter accepts", () => {
    expect(sessionFromHeaders(requestWith("org-a_1.b:c"))?.orgId).toBe("org-a_1.b:c");
  });

  it("rejects ids that could escape the org's storage prefix", () => {
    for (const orgId of ["a/b", "../x", "", "a b", `a${"x".repeat(200)}`]) {
      expect(sessionFromHeaders(requestWith(orgId)), orgId).toBeNull();
    }
  });
});
