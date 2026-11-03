import { useId, useState } from "react";
import { ISSUE_ROWS, type IssueRow, type IssueStatus } from "./issues-data";

function selectedId(hash: string): string {
  const match = hash.match(/^issues\/(.+)$/);
  return match?.[1] ?? "";
}

export function Issues({
  issues = ISSUE_ROWS,
  hash = typeof window === "undefined" ? "issues" : window.location.hash.replace(/^#\/?/, ""),
}: {
  issues?: IssueRow[];
  hash?: string;
}) {
  const checkId = useId();
  const statusId = useId();
  const subscriptionId = useId();
  const [check, setCheck] = useState("");
  const [status, setStatus] = useState<IssueStatus | "">("open");
  const [subscription, setSubscription] = useState("");
  const selected = issues.find((issue) => issue.id === selectedId(hash));
  const visible = issues.filter((issue) => {
    if (check && issue.checkId !== check) {
      return false;
    }
    if (status && issue.status !== status) {
      return false;
    }
    if (subscription && issue.subscription !== subscription) {
      return false;
    }
    return true;
  });
  const checks = [...new Set(issues.map((issue) => issue.checkId))];
  const subscriptions = [...new Set(issues.map((issue) => issue.subscription))];

  return (
    <>
      <h1 id="page-title" tabIndex={-1}>
        Issues
      </h1>
      <p>Stored issues with proof of coverage. An issue closes only when its scope was covered.</p>
      <form>
        <div>
          <label htmlFor={checkId}>Check</label>
          <select id={checkId} name="check" value={check} onChange={(event) => setCheck(event.target.value)}>
            <option value="">All checks</option>
            {checks.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={statusId}>Status</label>
          <select
            id={statusId}
            name="status"
            value={status}
            onChange={(event) => setStatus(event.target.value as IssueStatus | "")}
          >
            <option value="">All statuses</option>
            <option value="open">open</option>
            <option value="closed">closed</option>
            <option value="not_confirmed">not confirmed</option>
          </select>
        </div>
        <div>
          <label htmlFor={subscriptionId}>Subscription</label>
          <select
            id={subscriptionId}
            name="subscription"
            value={subscription}
            onChange={(event) => setSubscription(event.target.value)}
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
      <p role="status" aria-live="polite">
        {visible.length} issues
      </p>
      <table>
        <caption>Issue queue</caption>
        <thead>
          <tr>
            <th scope="col">Resource</th>
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
                <a href={`#issues/${issue.id}`}>{issue.resourceId}</a>
              </th>
              <td>{issue.checkId}</td>
              <td>{issue.status === "not_confirmed" ? "not confirmed" : issue.status}</td>
              <td>{issue.coverage}</td>
              <td>{issue.savings}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {selected ? (
        <article aria-labelledby="issue-detail-title">
          <h2 id="issue-detail-title">{selected.resourceId}</h2>
          <p>Check {selected.checkId}</p>
          <p>Evidence {selected.evidence}</p>
          <p>Savings {selected.savings}</p>
          <p>Coverage {selected.coverage}</p>
          <p>First seen {selected.firstSeen}</p>
          <p>Last confirmed {selected.lastConfirmed}</p>
          {selected.closingScanId ? <p>Closing scan {selected.closingScanId}</p> : null}
          {selected.notConfirmedReason ? <p>Not confirmed {selected.notConfirmedReason}</p> : null}
        </article>
      ) : null}
    </>
  );
}
