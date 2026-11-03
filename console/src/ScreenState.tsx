import type { ReactNode } from "react";
import { useSource } from "./data/context";
import { failureMessage } from "./data/error";
import { useResource, type Resource } from "./data/use-resource";

function PartialNotice() {
  const source = useSource();
  const overview = useResource((signal) => source.overview(signal), [source]);
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
      Partial: {notAssessed} {notAssessed === 1 ? "scope" : "scopes"} not assessed. What follows
      covers assessed scopes only. <a href="#blind-spots">See blind spots</a>
    </p>
  );
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
        {error.kind === "denied" ? null : (
          <button className="action action-primary" type="button" onClick={resource.retry}>
            Retry
          </button>
        )}
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
