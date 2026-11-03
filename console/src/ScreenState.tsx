import type { ReactNode } from "react";
import { useOverview } from "./data/context";
import { failureMessage, isRetryable } from "./data/error";
import type { EstateOverview } from "./data/types";
import type { Resource } from "./data/use-resource";
import { TERMS } from "./terms";

function PartialNotice() {
  const overview = useOverview();
  if (overview.status === "error") {
    return (
      <p className="notice">
        Coverage unknown: coverage could not be loaded, so these results may be partial.
      </p>
    );
  }
  if (overview.status !== "ready") {
    return null;
  }
  const { unassessed, undetermined } = overview.data.coverage;
  const notAssessed = unassessed + undetermined;
  if (notAssessed === 0) {
    return null;
  }
  return (
    <p className="notice">
      Partial: {notAssessed} {notAssessed === 1 ? "scope" : "scopes"} {TERMS.notAssessed}. What
      follows is limited to {TERMS.assessed} scopes. <a href="#blind-spots">See blind spots</a>
    </p>
  );
}

export function gapsMessage(overview: Resource<EstateOverview>, noneFound: string): string {
  if (overview.status !== "ready") {
    return "Coverage is unknown, so an empty list does not mean nothing is wrong.";
  }
  return overview.data.empty || overview.data.coverage.assessed === 0
    ? "Not checked yet. Connect a cloud estate and run a scan."
    : noneFound;
}

export function ScreenState<T>({
  label,
  resource,
  empty,
  missing,
  partial = false,
  children,
}: {
  label: string;
  resource: Resource<T>;
  empty?: (data: T) => ReactNode;
  missing?: string;
  partial?: boolean;
  children: (data: T) => ReactNode;
}) {
  if (resource.status === "loading") {
    return (
      <p className="screen-state" role="status">
        Loading {label}
      </p>
    );
  }
  if (resource.status === "error") {
    const { error } = resource;
    if (error.kind === "not-found" && missing) {
      return <p className="screen-state">{missing}</p>;
    }
    return (
      <div className="screen-state screen-state-alert" role="alert">
        <p>{failureMessage(error, `load ${label}`)}</p>
        {isRetryable(error) ? (
          <button className="action action-primary" type="button" onClick={resource.retry}>
            Retry
          </button>
        ) : null}
      </div>
    );
  }
  const emptyMessage = empty?.(resource.data);
  return (
    <>
      {partial ? <PartialNotice /> : null}
      {emptyMessage ? <p className="screen-state">{emptyMessage}</p> : children(resource.data)}
    </>
  );
}
