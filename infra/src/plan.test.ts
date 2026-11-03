import { describe, expect, it } from "vitest";
import { REQUIRED_TAG_KEYS } from "./tags.js";
import { PublicApiError, assertAuthenticatedEdge, planDevStack, untaggedResources } from "./plan.js";

describe("dev deploy plan", () => {
  const plan = planDevStack({
    customerName: "moonaan-dev",
    environment: "dev",
    accountId: "000000000000",
  });

  it("plans a health lambda and a console shell in the dedicated account", () => {
    expect(plan.accountId).toBe("000000000000");
    expect(plan.healthPath).toBe("/health");
    expect(plan.resources.map((resource) => resource.kind)).toEqual([
      "iam-role",
      "ssm-parameter",
      "log-group",
      "lambda",
      "lambda-url",
      "iam-role",
      "log-group",
      "lambda",
      "iam-role",
      "scheduler-schedule",
      "s3-bucket",
      "cloudfront",
    ]);
  });

  it("puts every function URL behind AWS_IAM", () => {
    const urls = plan.resources.filter((resource) => resource.kind === "lambda-url");
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((resource) => resource.authType === "AWS_IAM")).toBe(true);
  });

  it("serves only the console through CloudFront", () => {
    const cdn = plan.resources.find((resource) => resource.kind === "cloudfront");
    expect(cdn?.behaviors?.every((behavior) => behavior.origin === "console")).toBe(true);
    expect(() => assertAuthenticatedEdge(plan)).not.toThrow();
  });

  it("rejects a CloudFront behavior that routes /v1 to the Function URL without a viewer authenticator", () => {
    const routed = {
      ...plan,
      resources: plan.resources.map((resource) =>
        resource.kind === "cloudfront"
          ? {
              ...resource,
              behaviors: [
                ...(resource.behaviors ?? []),
                { pathPattern: "/v1/*", origin: "api" as const, signedToOrigin: true },
              ],
            }
          : resource,
      ),
    };
    expect(() => assertAuthenticatedEdge(routed)).toThrow(PublicApiError);
    const authenticated = {
      ...routed,
      resources: routed.resources.map((resource) =>
        resource.kind === "cloudfront" ? { ...resource, viewerAuthenticator: "edge-function" as const } : resource,
      ),
    };
    expect(() => assertAuthenticatedEdge(authenticated)).not.toThrow();
  });

  it("rejects an unauthenticated function URL on a stack serving /v1", () => {
    const open = {
      ...plan,
      resources: plan.resources.map((resource) =>
        resource.kind === "lambda-url" ? { ...resource, authType: "NONE" as const } : resource,
      ),
    };
    expect(plan.servesV1).toBe(true);
    expect(() => assertAuthenticatedEdge(open)).toThrow(PublicApiError);
    expect(() => assertAuthenticatedEdge({ ...open, servesV1: false })).not.toThrow();
  });

  it("tags every resource with the standard Moonaan set", () => {
    expect(untaggedResources(plan)).toEqual([]);
    for (const key of REQUIRED_TAG_KEYS) {
      expect(plan.tags[key]).toBeTruthy();
    }
    expect(plan.tags.product).toBe("farside");
    expect(plan.tags.customer).toBe("moonaan-dev");
    expect(plan.tags.managedBy).toBe("pulumi");
  });
});
