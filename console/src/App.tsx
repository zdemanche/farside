import { EMPTY_STATE, PRODUCT_NAME, SHELL_NAV } from "./shell";

export function App() {
  return (
    <div>
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
      <main>
        <h1>{PRODUCT_NAME}</h1>
        <p>{EMPTY_STATE}</p>
      </main>
    </div>
  );
}
