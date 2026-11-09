import { useCallback, useEffect, useState } from "react";
import { claimApi } from "./api";
import { toDataError } from "./error";
import {
  beginSignIn,
  browserStore,
  completeSignIn,
  isCallback,
  loadSession,
  signOut as forgetSession,
  type IdentityRuntime,
  type IdentitySession,
} from "./identity";
import type { ClaimView } from "./types";

export type IdentityState =
  | { phase: "off" }
  | { phase: "loading"; session: IdentitySession | null }
  | { phase: "signed-out"; problem: string | null }
  | { phase: "claim"; session: IdentitySession; view: ClaimView }
  | { phase: "ready"; session: IdentitySession };

const NO_ORG =
  "Your sign-in did not name an organisation, so Farside cannot tell which estate to show. Ask your administrator to check the organisation claim, then sign in again.";

let completing: { url: string; result: ReturnType<typeof completeSignIn> } | null = null;

/** Finishes a redirect once per URL, so a remounted effect does not replay the one-time code. */
function completeOnce(runtime: IdentityRuntime, url: string) {
  if (completing?.url !== url) {
    completing = { url, result: completeSignIn(runtime, url) };
  }
  return completing.result;
}

function withoutCallback(url: string, hash: string): string {
  const next = new URL(url);
  for (const key of ["code", "state", "error", "error_description", "session_state", "iss"]) {
    next.searchParams.delete(key);
  }
  next.hash = hash;
  return next.toString();
}

/**
 * Drives sign-in and the org claim when identity is configured. With no runtime it stays
 * `off` and the console behaves as before (demo, header session, or not connected).
 */
export function useIdentity(runtime: IdentityRuntime | null) {
  const [state, setState] = useState<IdentityState>(
    runtime ? { phase: "loading", session: null } : { phase: "off" },
  );
  const store = runtime?.storage ?? browserStore;

  const check = useCallback(
    async (session: IdentitySession): Promise<IdentityState> => {
      if (!runtime) {
        return { phase: "off" };
      }
      if (!session.orgId) {
        forgetSession(store);
        return { phase: "signed-out", problem: NO_ORG };
      }
      try {
        const view = await claimApi({
          baseUrl: runtime.apiUrl,
          orgId: session.orgId,
          token: session.token,
          ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
        }).status();
        return view.member ? { phase: "ready", session } : { phase: "claim", session, view };
      } catch (error) {
        const failed = toDataError(error);
        if (failed.kind === "unauthenticated") {
          forgetSession(store);
          return { phase: "signed-out", problem: "Your sign-in has ended. Sign in again." };
        }
        return {
          phase: "signed-out",
          problem:
            failed.kind === "network"
              ? "Could not reach the Farside API to check your organisation. Try again shortly."
              : `Could not check your organisation: ${failed.message}`,
        };
      }
    },
    [runtime, store],
  );

  useEffect(() => {
    if (!runtime) {
      setState({ phase: "off" });
      return;
    }
    let cancelled = false;
    const settle = (next: IdentityState) => {
      if (!cancelled) {
        setState(next);
      }
    };
    const currentUrl = runtime.currentUrl ?? (() => window.location.href);
    const replaceUrl =
      runtime.replaceUrl ??
      ((next: string) => {
        window.history.replaceState(null, "", next);
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
    const url = currentUrl();
    void (async () => {
      if (isCallback(url)) {
        try {
          const { session, returnHash } = await completeOnce(runtime, url);
          replaceUrl(withoutCallback(url, returnHash));
          settle({ phase: "loading", session });
          settle(await check(session));
        } catch (error) {
          replaceUrl(withoutCallback(url, new URL(url).hash));
          settle({
            phase: "signed-out",
            problem: error instanceof Error ? error.message : "Sign-in failed. Sign in again.",
          });
        }
        return;
      }
      const session = loadSession(store, (runtime.now ?? Date.now)());
      if (!session) {
        settle({ phase: "signed-out", problem: null });
        return;
      }
      settle({ phase: "loading", session });
      settle(await check(session));
    })();
    return () => {
      cancelled = true;
    };
  }, [runtime, store, check]);

  const signIn = useCallback(async () => {
    if (runtime) {
      await beginSignIn(runtime, window.location.hash);
    }
  }, [runtime]);

  const claim = useCallback(async () => {
    if (!runtime || state.phase !== "claim") {
      return;
    }
    const { session } = state;
    await claimApi({
      baseUrl: runtime.apiUrl,
      orgId: state.view.orgId,
      token: session.token,
      ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
    }).claim();
    setState({ phase: "ready", session });
  }, [runtime, state]);

  const signOut = useCallback(() => {
    forgetSession(store);
    setState({ phase: "signed-out", problem: null });
  }, [store]);

  return { state, signIn, claim, signOut };
}
