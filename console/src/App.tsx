import { useEffect, useState, type MouseEvent } from "react";
import { Connect } from "./Connect";
import { EMPTY_STATE, PRODUCT_NAME, SHELL_NAV } from "./shell";

function currentHash(): string {
  return window.location.hash.replace(/^#\/?/, "");
}

function skipToMain(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  document.getElementById("main")?.focus();
}

export function App() {
  const [hash, setHash] = useState(currentHash);

  useEffect(() => {
    const onHash = () => setHash(currentHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    document.getElementById("page-title")?.focus();
  }, [hash]);

  const onConnect = hash === "connect";

  return (
    <div>
      <a href="#main" onClick={skipToMain}>
        Skip to content
      </a>
      <header>
        <p>{PRODUCT_NAME}</p>
        <nav aria-label="Farside">
          <ul>
            {SHELL_NAV.map((item) => (
              <li key={item}>
                <a href={`#${item.toLowerCase().replaceAll(" ", "-")}`}>{item}</a>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main id="main" tabIndex={-1}>
        {onConnect ? (
          <Connect />
        ) : (
          <>
            <h1 id="page-title" tabIndex={-1}>
              {PRODUCT_NAME}
            </h1>
            <p>{EMPTY_STATE}</p>
          </>
        )}
      </main>
    </div>
  );
}
