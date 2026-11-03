import { useId, useState } from "react";
import { Chip, coverageTone, type Tone } from "./Chip";
import { ISSUE_ROWS, type IssueRow, type IssueStatus } from "./issues-data";

const STATUS_TONE: Record<IssueStatus, Tone> = {
  open: "warn",
  closed: "good",
  not_confirmed: "neutral",
};

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
      <h1 className="page-title" id="page-title" tabIndex={-1}>
        Issues
      </h1>
      <p className="page-description">
        Stored issues with proof of coverage. An issue closes only when its scope was covered.
      </p>
      <form className="panel filters">
        <div className="field">
          <label htmlFor={checkId}>Check</label>
          <select
            className="input"
            id={checkId}
            name="check"
            value={check}
            onChange={(event) => setCheck(event.target.value)}
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
            value={status}
            onChange={(event) => setStatus(event.target.value as IssueStatus | "")}
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
      <p className="page-meta" role="status" aria-live="polite">
        {visible.length} issues
      </p>
      <div className="table-wrap" tabIndex={0}>
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
                <td>
                  <Chip tone={STATUS_TONE[issue.status]}>
                    {issue.status === "not_confirmed" ? "not confirmed" : issue.status}
                  </Chip>
                </td>
                <td>
                  <Chip tone={coverageTone(issue.coverage)}>{issue.coverage}</Chip>
                </td>
                <td>{issue.savings}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected ? (
        <article className="panel detail" aria-labelledby="issue-detail-title">
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
