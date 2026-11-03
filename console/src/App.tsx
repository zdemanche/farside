import { useEffect, useState, type MouseEvent } from "react";
import { BlindSpots } from "./BlindSpots";
import { Connect } from "./Connect";
import { Estate } from "./Estate";
import { Inventory } from "./Inventory";
import { Issues } from "./Issues";
import { Lifecycle } from "./Lifecycle";
import { Recovery } from "./Recovery";
import { Scans } from "./Scans";
import { Settings } from "./Settings";
import { EMPTY_OVERVIEW, SEEDED_OVERVIEW } from "./estate-data";
import { DEMO_LABEL, EMPTY_STATE, PRODUCT_NAME, SHELL_NAV } from "./shell";

function currentHash(): string {
  return window.location.hash.replace(/^#\/?/, "");
}

function skipToMain(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  document.getElementById("main")?.focus();
}

export function App({ demo }: { demo?: boolean } = {}) {
  const demoMode = demo ?? import.meta.env.VITE_FARSIDE_DEMO === "1";
  const [hash, setHash] = useState(currentHash);

  useEffect(() => {
    const onHash = () => setHash(currentHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    document.getElementById("page-title")?.focus();
  }, [hash]);

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

  return (
    <div className="app">
      <a className="skip-link" href="#main" onClick={skipToMain}>
        Skip to content
      </a>
      <header className="topbar">
        <p className="brand">{PRODUCT_NAME}</p>
        {demoMode ? (
          <p className="chip chip-warn" role="status">
            {DEMO_LABEL}
          </p>
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
          {page === "connect" ? (
            <Connect />
          ) : page === "blind-spots" ? (
            <BlindSpots />
          ) : page === "estate" ? (
            <Estate overview={demoMode ? SEEDED_OVERVIEW : EMPTY_OVERVIEW} />
          ) : page === "inventory" ? (
            <Inventory />
          ) : page === "issues" ? (
            <Issues />
          ) : page === "settings" ? (
            <Settings />
          ) : page === "recovery" ? (
            <Recovery />
          ) : page === "lifecycle" ? (
            <Lifecycle />
          ) : page === "scans" ? (
            <Scans />
          ) : (
            <>
              <h1 className="page-title" id="page-title" tabIndex={-1}>
                {PRODUCT_NAME}
              </h1>
              <p className="screen-state">{EMPTY_STATE}</p>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
