import { describe, expect, it } from "vitest";
import { FederatedExchangeError } from "./azure-federated.js";
import { errorDetail } from "./error-detail.js";
import { GcpFederationError } from "./gcp-federation.js";

describe("errorDetail", () => {
  it("keeps the name, status and code of a refused Entra exchange, not its message", () => {
    const detail = errorDetail(new FederatedExchangeError(401, "AADSTS70021"));
    expect(detail).toEqual({ name: "FederatedExchangeError", status: 401, code: "AADSTS70021" });
    expect(JSON.stringify(detail)).not.toContain("refused");
  });

  it("keeps the step and status of a refused GCP federation", () => {
    const detail = errorDetail(new GcpFederationError("sts", 400));
    expect(detail).toMatchObject({ name: "GcpFederationError", status: 400, step: "sts" });
  });

  it("drops anything that is not a short safe token", () => {
    const error = Object.assign(new Error("secret message"), {
      code: "has spaces and a token eyJhbGciOi",
      step: "x".repeat(200),
    });
    expect(errorDetail(error)).toEqual({ name: "Error" });
  });

  it("handles a non-error", () => {
    expect(errorDetail("boom")).toEqual({ name: "UnknownError" });
    expect(errorDetail(null)).toEqual({ name: "UnknownError" });
  });
});
