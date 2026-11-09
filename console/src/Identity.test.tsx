import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { PKCE_KEY, SESSION_KEY, type IdentityRuntime } from "./data/identity";
import type { ClaimView } from "./data/types";
import { CLAIM_TITLE, JOIN_TITLE, PRODUCT_NAME, SHELL_NAV, SIGN_IN_TITLE } from "./shell";
import { expectAxeClean, fakeJwt, memoryStore } from "./test-utils";

const TOKEN = fakeJwt({ sub: "u1", org: "org-a", email: "cto@example.test", exp: 4_000_000_000 });

const VIEW = (overrides: Partial<ClaimView> = {}): ClaimView => ({
  orgId: "org-a",
  claimed: false,
  claimedAt: null,
  role: null,
  member: false,
  owner: false,
  memberCount: 0,
  ...overrides,
});

const PAYLOADS: Record<string, unknown> = {
  "/estate": {
    empty: true,
    resourceTotal: 0,
    noOwnerTotal: 0,
    coverage: { assessed: 0, unassessed: 0, undetermined: 0 },
    healthScore: null,
  },
  "/scans": { scans: [] },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setup({
  view = VIEW(),
  claimStatus = 200,
  claimReply = {
    status: 201,
    body: {
      outcome: "claimed",
      ...VIEW({ claimed: true, member: true, role: "owner", owner: true, memberCount: 1 }),
    } as unknown,
  },
  url = "https://console.test/",
  signedIn = true,
  token = TOKEN,
}: {
  view?: ClaimView;
  claimStatus?: number;
  claimReply?: { status: number; body: unknown };
  url?: string;
  signedIn?: boolean;
  token?: string;
} = {}) {
  const storage = memoryStore();
  if (signedIn) {
    storage.set(
      SESSION_KEY,
      JSON.stringify({ token, expiresAt: null, orgId: "org-a", name: "cto@example.test" }),
    );
  }
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input);
    requests.push({ url: target, init });
    if (target.endsWith("/.well-known/openid-configuration")) {
      return json({
        authorization_endpoint: "https://idp.test/authorize",
        token_endpoint: "https://idp.test/token",
      });
    }
    if (target === "https://idp.test/token") {
      return json({ access_token: TOKEN, expires_in: 300 });
    }
    const path = target.replace("https://api.test/v1/orgs/org-a", "").split("?")[0] ?? "";
    if (path === "/claim") {
      return init?.method === "POST"
        ? json(claimReply.body, claimReply.status)
        : json(claimStatus === 200 ? view : { title: "Unauthorized" }, claimStatus);
    }
    return path in PAYLOADS ? json(PAYLOADS[path]) : json({ title: "Not found" }, 404);
  });
  const navigate = vi.fn();
  const replaceUrl = vi.fn();
  const runtime: IdentityRuntime = {
    apiUrl: "https://api.test",
    config: {
      issuer: "https://idp.test",
      clientId: "farside-console",
      redirectUri: "https://console.test/",
      scope: "openid profile email",
      providerName: "Moonaan Identity",
      orgClaim: "org",
    },
    fetch,
    storage,
    navigate,
    currentUrl: () => url,
    replaceUrl,
  };
  return { runtime, storage, requests, navigate, replaceUrl };
}

describe("sign-in and org claim", () => {
  afterEach(() => {
    cleanup();
    window.location.hash = "";
  });

  it("shows only the sign-in screen, titled and accessible, when signed out", async () => {
    const { runtime, navigate } = setup({ signedIn: false });
    const { container } = render(<App identity={runtime} />);
    expect(await screen.findByRole("heading", { level: 1, name: SIGN_IN_TITLE })).toBeTruthy();
    await waitFor(() => expect(document.title).toBe(`${SIGN_IN_TITLE} - ${PRODUCT_NAME}`));
    expect(screen.queryByRole("navigation", { name: PRODUCT_NAME })).toBeNull();
    expect(screen.getByRole("link", { name: "Skip to content" })).toBeTruthy();
    expect(screen.queryByLabelText("Cloud")).toBeNull();
    await expectAxeClean(container);

    fireEvent.click(screen.getByRole("button", { name: "Sign in with Moonaan Identity" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    const target = new URL(navigate.mock.calls[0]?.[0] as string);
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    expect(target.searchParams.get("client_id")).toBe("farside-console");
  });

  it("finishes the redirect, cleans the URL, and offers the claim to the first user", async () => {
    const { runtime, storage, replaceUrl } = setup({
      signedIn: false,
      url: "https://console.test/?code=abc&state=st8",
    });
    storage.set(PKCE_KEY, JSON.stringify({ verifier: "v", state: "st8", returnHash: "#issues" }));
    const { container } = render(<App identity={runtime} />);
    expect(await screen.findByRole("heading", { level: 1, name: CLAIM_TITLE })).toBeTruthy();
    expect(replaceUrl).toHaveBeenCalledWith("https://console.test/#issues");
    await waitFor(() => expect(document.title).toBe(`${CLAIM_TITLE} - ${PRODUCT_NAME}`));
    expect(screen.getByText("Signed in as cto@example.test")).toBeTruthy();
    expect(screen.getByText("Owner")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: PRODUCT_NAME })).toBeNull();
    await expectAxeClean(container);
  });

  it("claims the org, then opens the console with the bearer token and full navigation", async () => {
    const { runtime, requests } = setup();
    render(<App identity={runtime} />);
    fireEvent.click(await screen.findByRole("button", { name: "Claim organisation" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Estate" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: PRODUCT_NAME });
    for (const item of SHELL_NAV) {
      expect(within(nav).getByRole("link", { name: item })).toBeTruthy();
    }
    await waitFor(() => expect(document.activeElement?.id).toBe("page-title"));
    const apiCalls = requests.filter((request) => request.url.startsWith("https://api.test"));
    expect(apiCalls.some((request) => request.init?.method === "POST")).toBe(true);
    for (const request of apiCalls) {
      expect(request.init?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
      expect(request.init?.headers).not.toHaveProperty("x-farside-org");
    }
  });

  it("offers to join an org someone already claimed", async () => {
    const { runtime } = setup({
      view: VIEW({ claimed: true, claimedAt: "2026-11-01T00:00:00Z", memberCount: 3 }),
      claimReply: {
        status: 200,
        body: {
          outcome: "joined",
          ...VIEW({ claimed: true, member: true, role: "member", memberCount: 4 }),
        },
      },
    });
    const { container } = render(<App identity={runtime} />);
    expect(await screen.findByRole("heading", { level: 1, name: JOIN_TITLE })).toBeTruthy();
    expect(screen.getByText(/already set up in Farside with 3 members/)).toBeTruthy();
    await expectAxeClean(container);
    fireEvent.click(screen.getByRole("button", { name: "Join organisation" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Estate" })).toBeTruthy();
  });

  it("goes straight to the console for a member", async () => {
    const { runtime } = setup({
      view: VIEW({ claimed: true, member: true, role: "member", memberCount: 2 }),
    });
    render(<App identity={runtime} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Estate" })).toBeTruthy();
    expect(screen.getByLabelText("Cloud")).toBeTruthy();
  });

  it("explains a refused claim without leaving the screen", async () => {
    const { runtime } = setup({
      claimReply: {
        status: 403,
        body: { title: "Claim needs the owner role", error: "claim_role_required" },
      },
    });
    render(<App identity={runtime} />);
    fireEvent.click(await screen.findByRole("button", { name: "Claim organisation" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/does not have the role needed/);
    expect(screen.getByRole("heading", { level: 1, name: CLAIM_TITLE })).toBeTruthy();
  });

  it("signs out to the sign-in screen and forgets the token", async () => {
    const { runtime, storage } = setup({
      view: VIEW({ claimed: true, member: true, role: "owner" }),
    });
    render(<App identity={runtime} />);
    await screen.findByRole("heading", { level: 1, name: "Estate" });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { level: 1, name: SIGN_IN_TITLE })).toBeTruthy();
    expect(storage.data.has(SESSION_KEY)).toBe(false);
    await waitFor(() => expect(document.activeElement?.id).toBe("page-title"));
  });

  it("asks to sign in again when the API rejects the token", async () => {
    const { runtime, storage } = setup({ claimStatus: 401 });
    render(<App identity={runtime} />);
    expect(await screen.findByRole("heading", { level: 1, name: SIGN_IN_TITLE })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Your sign-in has ended. Sign in again.");
    expect(storage.data.has(SESSION_KEY)).toBe(false);
  });

  it("explains a callback whose state does not match", async () => {
    const { runtime, storage } = setup({
      signedIn: false,
      url: "https://console.test/?code=abc&state=forged",
    });
    storage.set(PKCE_KEY, JSON.stringify({ verifier: "v", state: "st8", returnHash: "" }));
    render(<App identity={runtime} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /did not match this browser tab/,
    );
  });

  it("is ignored in demo mode and with an explicit source", async () => {
    const { runtime } = setup({ signedIn: false });
    render(<App demo identity={runtime} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Estate" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: SIGN_IN_TITLE })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });
});
