import { useEffect, useId, useState } from "react";
import { Chip, coverageTone, type Tone } from "./Chip";
import { useSource } from "./data/context";
import type { IssueRow, IssueStatus } from "./data/types";
import { useResource } from "./data/use-resource";
import { formatMoney, Time } from "./format";
import { ExportButton } from "./ExportButton";
import { LastScan } from "./LastScan";
import { inventoryHref, scanHref } from "./links";
import { ScreenState } from "./ScreenState";
import { plural } from "./plural";
import { CLOUD_LABEL, TERMS, coverageStateLabel, shortName } from "./terms";

const STATUS_TONE: Record<IssueStatus, Tone> = {
  open: "warn",
  closed: "good",
  not_confirmed: "neutral",
};

type Filters = {
  check: string;
  status: IssueStatus | "";
  subscription: string;
};

const DEFAULT_FILTERS: Filters = {
  check: "",
  status: "open",
  subscription: "",
};
const NO_FILTERS: Filters = { check: "", status: "", subscription: "" };

function selectedId(hash: string): string {
  const match = hash.match(/^issues\/(.+)$/)?.[1] ?? "";
  try {
    return decodeURIComponent(match);
  } catch {
    return match;
  }
}

function currentHash(): string {
  return typeof window === "undefined" ? "issues" : window.location.hash.replace(/^#\/?/, "");
}

function IssuesBody({ issues, hash }: { issues: IssueRow[]; hash: string }) {
  const checkId = useId();
  const statusId = useId();
  const subscriptionId = useId();
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const detailId = selectedId(hash);
  const selected = issues.find((issue) => issue.id === detailId);
  useEffect(() => {
    if (detailId) {
      document.getElementById("issue-detail-title")?.focus();
    }
  }, [detailId, selected?.id]);
  const passes = (issue: IssueRow, skipStatus: boolean) =>
    (!filters.check || issue.checkId === filters.check) &&
    (skipStatus || !filters.status || issue.status === filters.status) &&
    (!filters.subscription || issue.subscription === filters.subscription);
  const visible = issues.filter((issue) => passes(issue, false));
  const hiddenByStatus = filters.status
    ? issues.filter((issue) => passes(issue, true) && issue.status !== filters.status).length
    : 0;
  const checks = [...new Set(issues.map((issue) => issue.checkId))];
  const subscriptions = [...new Set(issues.map((issue) => issue.subscription))];

  return (
    <>
      <form className="panel filters" role="search" aria-label="Filter issues">
        <div className="field">
          <label htmlFor={checkId}>Check</label>
          <select
            className="input"
            id={checkId}
            name="check"
            value={filters.check}
            onChange={(event) => setFilters({ ...filters, check: event.target.value })}
          >
            <option value="">All checks</option>
            {checks.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={statusId}>Status</label>
          <select
            className="input"
            id={statusId}
            name="status"
            value={filters.status}
            onChange={(event) =>
              setFilters({
                ...filters,
                status: event.target.value as IssueStatus | "",
              })
            }
          >
            <option value="">All statuses</option>
            <option value="open">open</option>
            <option value="closed">closed</option>
            <option value="not_confirmed">not confirmed</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={subscriptionId}>Subscription</label>
          <select
            className="input"
            id={subscriptionId}
            name="subscription"
            value={filters.subscription}
            onChange={(event) => setFilters({ ...filters, subscription: event.target.value })}
          >
            <option value="">All subscriptions</option>
            {subscriptions.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
      </form>
      <p className="page-meta" role="status" aria-live="polite">
        {plural(visible.length, "issue")}
      </p>
      {hiddenByStatus > 0 ? (
        <p className="notice">
          Showing {filters.status.replace("_", " ")} issues only. {hiddenByStatus} more{" "}
          {hiddenByStatus === 1 ? "issue is" : "issues are"} hidden by the status filter.{" "}
          <button
            className="action action-secondary"
            type="button"
            onClick={() => setFilters({ ...filters, status: "" })}
          >
            Show all statuses
          </button>
        </p>
      ) : null}
      {visible.length === 0 ? (
        <p className="screen-state">
          No issues match these filters.{" "}
          <button
            className="action action-secondary"
            type="button"
            onClick={() => setFilters(NO_FILTERS)}
          >
            Clear filters
          </button>
        </p>
      ) : (
        <div className="table-wrap" role="region" aria-labelledby="issues-caption" tabIndex={0}>
          <table>
            <caption id="issues-caption">Issue queue</caption>
            <thead>
              <tr>
                <th scope="col">Resource</th>
                <th scope="col">Cloud</th>
                <th scope="col">Check</th>
                <th scope="col">Status</th>
                <th scope="col">Coverage</th>
                <th scope="col">Savings</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((issue) => (
                <tr key={issue.id}>
                  <th scope="row">
                    <a href={`#issues/${encodeURIComponent(issue.id)}`} title={issue.resourceId}>
                      {shortName(issue.resourceId)}
                    </a>
                  </th>
                  <td>{CLOUD_LABEL[issue.cloud]}</td>
                  <td>{issue.checkId}</td>
                  <td>
                    <Chip tone={STATUS_TONE[issue.status]}>
                      {issue.status === "not_confirmed" ? "not confirmed" : issue.status}
                    </Chip>
                  </td>
                  <td>
                    <Chip tone={coverageTone(issue.coverage)}>
                      {coverageStateLabel(issue.coverage)}
                    </Chip>
                  </td>
                  <td>{formatMoney(issue.savings)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected ? (
        <article className="panel detail" aria-labelledby="issue-detail-title">
          <h2 id="issue-detail-title" tabIndex={-1} title={selected.resourceId}>
            {shortName(selected.resourceId)}
          </h2>
          <p>
            Resource <a href={inventoryHref(selected.resourceId)}>Find in Inventory</a>
          </p>
          <p>Check {selected.checkId}</p>
          <p>Evidence {selected.evidence}</p>
          <p>Savings {formatMoney(selected.savings)}</p>
          <p>Coverage {coverageStateLabel(selected.coverage)}</p>
          <p>
            First seen <Time value={selected.firstSeen} />
          </p>
          <p>
            Last confirmed <Time value={selected.lastConfirmed} />
          </p>
          {selected.closingScanId ? (
            <p>
              Closing scan <a href={scanHref(selected.closingScanId)}>{selected.closingScanId}</a>
            </p>
          ) : null}
          {selected.notConfirmedReason ? (
            <p>
              Not confirmed {selected.notConfirmedReason} <a href="#blind-spots">See blind spots</a>
            </p>
          ) : null}
        </article>
      ) : detailId ? (
        <article className="panel detail" aria-labelledby="issue-detail-title">
          <h2 id="issue-detail-title" tabIndex={-1}>
            Issue {detailId} was not found
          </h2>
          <p>
            <a href="#issues">Back to all issues</a>
          </p>
        </article>
      ) : null}
    </>
  );
}

export function Issues({ hash = currentHash() }: { hash?: string }) {
  const source = useSource();
  const issues = useResource((signal) => source.issues(signal), [source]);
  return (
    <>
      <h1 className="page-title" id="page-title" tabIndex={-1}>
        Issues
      </h1>
      <p className="page-description">
        Stored issues with proof the scope was {TERMS.assessed}. An issue closes only when its scope
        was {TERMS.assessed}.
      </p>
      <LastScan />
      <ExportButton kind="issues" label="Export issues" />
      <ScreenState
        label="issues"
        resource={issues}
        partial
        empty={(data) =>
          data.length === 0 && !selectedId(hash)
            ? "No issues have been recorded. Issues appear after a scan finds a problem on an assessed scope."
            : null
        }
      >
        {(data) => <IssuesBody issues={data} hash={hash} />}
      </ScreenState>
    </>
  );
}
