import { useSource } from "./data/context";
import type { HeadlineFigure, HeadlineValue } from "./data/types";
import { useResource } from "./data/use-resource";
import { formatAmount } from "./format";
import { plural } from "./plural";
import { TERMS } from "./terms";

function describe(value: HeadlineValue, id: HeadlineFigure["id"]): string {
  if ("byCloud" in value) {
    return Object.entries(value.byCloud)
      .map(([cloud, inner]) => `${cloud}: ${describe(inner, id)}`)
      .join("; ");
  }
  if ("amount" in value) {
    return value.amount === null
      ? "no figure"
      : `${formatAmount(value.amount, value.currency)} a month`;
  }
  if ("min" in value) {
    return `${formatAmount(value.min, value.currency)} to ${formatAmount(value.max, value.currency)} a month`;
  }
  if ("unprotected" in value) {
    return `${value.unprotected} of ${value.production}${
      value.undetermined > 0 ? `, ${value.undetermined} undetermined` : ""
    }`;
  }
  return id === "unseen" ? plural(value.count, "scope") : String(value.count);
}

function Figure({ figure }: { figure: HeadlineFigure }) {
  // A figure whose checks were not assessed, or have no live run, never shows a number.
  const text =
    figure.status === "ok" && figure.value
      ? describe(figure.value, figure.id)
      : figure.status === "not_supported"
        ? "not supported"
        : TERMS.notAssessed;
  return (
    <li className="stat">
      <a href={figure.href}>{figure.label}</a> <span>{text}</span>
    </li>
  );
}

export function Headline() {
  const source = useSource();
  const headline = useResource((signal) => source.headline(signal), [source]);
  if (headline.status === "loading") {
    return null;
  }
  if (headline.status === "error") {
    return (
      <p className="notice">
        The headline could not be loaded, so no cost, waste or support figures are shown.
      </p>
    );
  }
  return (
    <section aria-labelledby="headline-title">
      <h2 id="headline-title">Headline</h2>
      <p className="page-description">{headline.data.sentence}</p>
      <ul className="stats" role="list">
        {headline.data.figures.map((figure) => (
          <Figure key={figure.id} figure={figure} />
        ))}
      </ul>
    </section>
  );
}
