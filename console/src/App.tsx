import { useEffect, useRef, useState, type MouseEvent } from "react";
import { apiSource } from "./data/api";
import { DataProvider } from "./data/context";
import type { DataSource } from "./data/types";
import { BlindSpots } from "./BlindSpots";
import { Connect } from "./Connect";
import { Estate } from "./Estate";
import { Inventory } from "./Inventory";
import { Issues } from "./Issues";
import { Lifecycle } from "./Lifecycle";
import { Recovery } from "./Recovery";
import { Scans } from "./Scans";
import { Settings } from "./Settings";
import { DEMO_LABEL, EMPTY_STATE, NOT_CONNECTED_STATE, PRODUCT_NAME, SHELL_NAV } from "./shell";

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

const PAGE_TITLES: Record<string, string> = {
  connect: "Connect",
  "blind-spots": "Blind spots",
  estate: "Estate",
  inventory: "Inventory",
  issues: "Issues",
  settings: "Settings",
  recovery: "Recovery",
  lifecycle: "Lifecycle",
  scans: "Scans",
};

function pageTitle(page: string): string {
  const label = PAGE_TITLES[page];
  return label ? `${label} - ${PRODUCT_NAME}` : PRODUCT_NAME;
}

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

  const page =
    hash === "connect"
      ? "connect"
      : hash === "blind-spots"
        ? "blind-spots"
        : hash === "estate"
          ? "estate"
          : hash === "inventory"
            ? "inventory"
            : hash === "issues" || hash.startsWith("issues/")
              ? "issues"
              : hash === "settings"
                ? "settings"
                : hash === "recovery"
                  ? "recovery"
                  : hash === "lifecycle"
                    ? "lifecycle"
                    : hash === "scans" || hash.startsWith("scans/")
                      ? "scans"
                      : "empty";

  const firstHash = useRef(true);
  useEffect(() => {
    document.title = pageTitle(page);
  }, [page]);

  useEffect(() => {
    if (firstHash.current) {
      firstHash.current = false;
      return;
    }
    if (hash.includes("/")) {
      return;
    }
    document.getElementById("page-title")?.focus();
  }, [hash]);

  return (
    <div className="app">
      <a className="skip-link" href="#main" onClick={skipToMain}>
        Skip to content
      </a>
      <header className="topbar">
        <p className="brand">{PRODUCT_NAME}</p>
        {resolved?.mode === "demo" ? (
          <p className="chip chip-warn">{DEMO_LABEL}</p>
        ) : null}
      </header>
      <div className="layout">
        <nav className="sidenav" aria-label="Farside">
          <ul>
            {SHELL_NAV.map((item) => {
              const slug = item.toLowerCase().replaceAll(" ", "-");
              return (
                <li key={item}>
                  <a href={`#${slug}`} aria-current={slug === hash.split("/")[0] ? "page" : undefined}>
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
          ) : (
            <DataProvider source={resolved}>
              {page === "connect" ? (
                <Connect />
              ) : page === "blind-spots" ? (
                <BlindSpots />
              ) : page === "estate" ? (
                <Estate />
              ) : page === "inventory" ? (
                <Inventory />
              ) : page === "issues" ? (
                <Issues hash={hash} />
              ) : page === "settings" ? (
                <Settings />
              ) : page === "recovery" ? (
                <Recovery />
              ) : page === "lifecycle" ? (
                <Lifecycle />
              ) : page === "scans" ? (
                <Scans hash={hash} />
              ) : (
                <>
                  <h1 className="page-title" id="page-title" tabIndex={-1}>
                    {PRODUCT_NAME}
                  </h1>
                  <p className="screen-state">{EMPTY_STATE}</p>
                </>
              )}
            </DataProvider>
          )}
        </main>
      </div>
    </div>
  );
}
