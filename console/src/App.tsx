import { useEffect, useRef, useState, type ComponentType, type MouseEvent } from "react";
import { apiSource } from "./data/api";
import { DataProvider } from "./data/context";
import type { DataSource } from "./data/types";
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
import { DEMO_LABEL, NOT_CONNECTED_STATE, PRODUCT_NAME, SHELL_NAV, slugOf } from "./shell";

function configuredSource(): DataSource | null {
  const baseUrl: string | undefined = import.meta.env.VITE_FARSIDE_API_URL;
  const orgId: string | undefined = import.meta.env.VITE_FARSIDE_ORG;
  return baseUrl && orgId ? apiSource({ baseUrl, orgId }) : null;
}

async function resolveSource(demo: boolean | undefined): Promise<DataSource | null> {
  if (demo ?? import.meta.env.VITE_FARSIDE_DEMO === "1") {
    const { demoSource } = await import("./data/demo");
    return demoSource();
  }
  return configuredSource();
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

export function App({ demo, source }: { demo?: boolean; source?: DataSource | null } = {}) {
  const [resolved, setResolved] = useState<DataSource | null | undefined>(source);
  const [hash, setHash] = useState(currentHash);

  useEffect(() => {
    if (source !== undefined) {
      setResolved(source);
      return;
    }
    let cancelled = false;
    void resolveSource(demo).then((next) => {
      if (!cancelled) {
        setResolved(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [demo, source]);

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
    document.title = resolved ? `${title} - ${PRODUCT_NAME}` : PRODUCT_NAME;
  }, [title, resolved]);

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
      </header>
      <div className="layout">
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
        <main className="main" id="main" tabIndex={-1}>
          {resolved === undefined ? (
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
