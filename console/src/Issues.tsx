import { ISSUE_ROWS, type IssueRow } from "./issues";

export function Issues({ issues = ISSUE_ROWS }: { issues?: IssueRow[] }) {
  return (
    <>
      <h1 id="page-title" tabIndex={-1}>
        Issues
      </h1>
      <p>Fail findings from the last scan, with evidence and a savings range.</p>
      <p role="status" aria-live="polite">
        {issues.length} open issues
      </p>
      <table>
        <caption>Open waste issues</caption>
        <thead>
          <tr>
            <th scope="col">Resource</th>
            <th scope="col">Check</th>
            <th scope="col">Evidence</th>
            <th scope="col">Savings</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue) => (
            <tr key={issue.id}>
              <th scope="row">{issue.resourceId}</th>
              <td>{issue.checkId}</td>
              <td>{issue.evidence}</td>
              <td>{issue.savings}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
