import { useEffect, useRef, useState, type ComponentType, type MouseEvent } from "react";
import { CLOUDS, type Cloud } from "@farside/scan-contracts";
import { apiSource } from "./data/api";
import { DataProvider } from "./data/context";
import { identityFromEnv, type IdentityRuntime } from "./data/identity";
import type { DataSource } from "./data/types";
import { useIdentity, type IdentityState } from "./data/use-identity";
import { Billing } from "./Billing";
import { BlindSpots } from "./BlindSpots";
import { Connect } from "./Connect";
import { CostWaste } from "./CostWaste";
import { Estate } from "./Estate";
import { Inventory } from "./Inventory";
import { Issues } from "./Issues";
import { Lifecycle } from "./Lifecycle";
import { Recovery } from "./Recovery";
import { Scans } from "./Scans";
import { Settings } from "./Settings";
import { NotFound } from "./NotFound";
import { Offboarding } from "./Offboarding";
import { OrgClaim } from "./OrgClaim";
import { SignIn } from "./SignIn";
import {
  CLAIM_TITLE,
  DEMO_LABEL,
  JOIN_TITLE,
  NOT_CONNECTED_STATE,
  PRODUCT_NAME,
  SHELL_NAV,
  SIGN_IN_TITLE,
  slugOf,
} from "./shell";
import { CLOUD_LABEL } from "./terms";

function configuredSource(cloud: Cloud | ""): DataSource | null {
  const baseUrl: string | undefined = import.meta.env.VITE_FARSIDE_API_URL;
  const orgId: string | undefined = import.meta.env.VITE_FARSIDE_ORG;
  return baseUrl && orgId ? apiSource({ baseUrl, orgId, ...(cloud ? { cloud } : {}) }) : null;
}

async function resolveSource(
  demo: boolean | undefined,
  cloud: Cloud | "",
): Promise<DataSource | null> {
  if (demo ?? import.meta.env.VITE_FARSIDE_DEMO === "1") {
    const { demoSource } = await import("./data/demo");
    return demoSource(cloud || undefined);
  }
  return configuredSource(cloud);
}

function gateTitle(state: IdentityState): string | null {
  switch (state.phase) {
    case "signed-out":
      return SIGN_IN_TITLE;
    case "claim":
      return state.view.claimed ? JOIN_TITLE : CLAIM_TITLE;
    case "loading":
      return PRODUCT_NAME;
    default:
      return null;
  }
}

function currentHash(): string {
  return window.location.hash.replace(/^#\/?/, "");
}

const PAGES: Record<string, ComponentType> = {
  estate: Estate,
  connect: Connect,
  scans: Scans,
  settings: Settings,
  inventory: Inventory,
  issues: Issues,
  "cost-and-waste": CostWaste,
  lifecycle: Lifecycle,
  recovery: Recovery,
  "blind-spots": BlindSpots,
  billing: Billing,
  offboarding: Offboarding,
};

const DETAIL_PAGES = new Set(["issues", "scans"]);

const TITLES = new Map(SHELL_NAV.map((item) => [slugOf(item), item]));

function skipToMain(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  document.getElementById("main")?.focus();
}

export function App({
  demo,
  source,
  identity,
}: {
  demo?: boolean;
  source?: DataSource | null;
  /** Sign-in runtime; defaults to the VITE_FARSIDE_IDENTITY_* env. Ignored with a source or demo. */
  identity?: IdentityRuntime | null;
} = {}) {
  const [resolved, setResolved] = useState<DataSource | null | undefined>(source);
  const [hash, setHash] = useState(currentHash);
  const [cloud, setCloud] = useState<Cloud | "">("");
  const [envIdentity] = useState(() =>
    identity === undefined ? identityFromEnv(import.meta.env, window.location) : null,
  );
  const runtime =
    source !== undefined || demo ? null : identity === undefined ? envIdentity : identity;
  const auth = useIdentity(runtime);
  const session = auth.state.phase === "ready" ? auth.state.session : null;
  const gate = runtime ? gateTitle(auth.state) : null;

  useEffect(() => {
    if (source !== undefined) {
      setResolved(source);
      return;
    }
    if (runtime) {
      setResolved(
        session?.orgId
          ? apiSource({
              baseUrl: runtime.apiUrl,
              orgId: session.orgId,
              token: session.token,
              ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
              ...(cloud ? { cloud } : {}),
            })
          : undefined,
      );
      return;
    }
    let cancelled = false;
    void resolveSource(demo, cloud).then((next) => {
      if (!cancelled) {
        setResolved(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [demo, source, cloud, runtime, session]);

  useEffect(() => {
    const onHash = () => setHash(currentHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const [path = ""] = hash.split("?");
  const [route = "", ...detail] = path.split("/");
  const slug = route || "estate";
  const isDetail = detail.length > 0;
  const Page = PAGES[slug] && (!isDetail || DETAIL_PAGES.has(slug)) ? PAGES[slug] : undefined;
  const title = Page ? (TITLES.get(slug) ?? PRODUCT_NAME) : "Page not found";

  const firstHash = useRef(true);
  useEffect(() => {
    document.title =
      gate && gate !== PRODUCT_NAME
        ? `${gate} - ${PRODUCT_NAME}`
        : resolved && !gate
          ? `${title} - ${PRODUCT_NAME}`
          : PRODUCT_NAME;
  }, [title, resolved, gate]);

  // After a sign-in step the user took (claim, join, sign out), focus the new screen's heading.
  // The first settled screen on load keeps the skip link as the first tab stop.
  const settledOnce = useRef(false);
  const focusPending = useRef(false);
  useEffect(() => {
    const phase = auth.state.phase;
    if (phase === "off" || phase === "loading") {
      return;
    }
    if (settledOnce.current) {
      focusPending.current = true;
    }
    settledOnce.current = true;
  }, [auth.state.phase]);
  useEffect(() => {
    if (!focusPending.current || (auth.state.phase === "ready" && !resolved)) {
      return;
    }
    focusPending.current = false;
    document.getElementById("page-title")?.focus();
  });

  const signedInAs =
    auth.state.phase === "ready" || auth.state.phase === "claim"
      ? (auth.state.session.name ?? auth.state.session.orgId)
      : null;

  useEffect(() => {
    if (firstHash.current) {
      firstHash.current = false;
      return;
    }
    if (Page && isDetail) {
      return;
    }
    document.getElementById("page-title")?.focus();
  }, [hash, isDetail, Page]);

  return (
    <div className="app">
      <a className="skip-link" href="#main" onClick={skipToMain}>
        Skip to content
      </a>
      <header className="topbar">
        <p className="brand">{PRODUCT_NAME}</p>
        {resolved?.mode === "demo" ? <p className="chip chip-warn">{DEMO_LABEL}</p> : null}
        {source === undefined && resolved && !gate ? (
          <div className="field cloud-filter">
            <label htmlFor="cloud-filter">Cloud</label>
            <select
              className="input"
              id="cloud-filter"
              value={cloud}
              onChange={(event) => setCloud(event.target.value as Cloud | "")}
            >
              <option value="">All clouds</option>
              {CLOUDS.map((value) => (
                <option key={value} value={value}>
                  {CLOUD_LABEL[value]}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {signedInAs ? (
          <div className="account">
            <p className="account-name">Signed in as {signedInAs}</p>
            <button className="action action-secondary" type="button" onClick={auth.signOut}>
              Sign out
            </button>
          </div>
        ) : null}
      </header>
      <div className="layout">
        {gate ? null : (
          <nav className="sidenav" aria-label="Farside">
            <ul>
              {SHELL_NAV.map((item) => {
                const itemSlug = slugOf(item);
                return (
                  <li key={item}>
                    <a
                      href={`#${itemSlug}`}
                      aria-current={Page && itemSlug === slug ? "page" : undefined}
                    >
                      {item}
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}
        <main className="main" id="main" tabIndex={-1}>
          {auth.state.phase === "signed-out" && runtime ? (
            <SignIn
              providerName={runtime.config.providerName}
              onSignIn={auth.signIn}
              problem={auth.state.problem}
            />
          ) : auth.state.phase === "claim" ? (
            <OrgClaim
              view={auth.state.view}
              signedInAs={auth.state.session.name}
              onClaim={auth.claim}
            />
          ) : resolved === undefined || gate ? (
            <>
              <h1 className="page-title" id="page-title" tabIndex={-1}>
                {PRODUCT_NAME}
              </h1>
              <p className="screen-state" role="status">
                Loading
              </p>
            </>
          ) : resolved === null ? (
            <>
              <h1 className="page-title" id="page-title" tabIndex={-1}>
                {PRODUCT_NAME}
              </h1>
              <p className="screen-state" role="alert">
                {NOT_CONNECTED_STATE}
              </p>
            </>
          ) : Page ? (
            <DataProvider source={resolved}>
              <Page />
            </DataProvider>
          ) : (
            <NotFound hash={hash} />
          )}
        </main>
      </div>
    </div>
  );
}
