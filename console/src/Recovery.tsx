import { RECOVERY_BACKUP, RECOVERY_ROWS, type RecoveryRow } from "./recovery";

export function Recovery({
  rows = RECOVERY_ROWS,
  unprotected = RECOVERY_BACKUP.unprotected,
  production = RECOVERY_BACKUP.production,
}: {
  rows?: RecoveryRow[];
  unprotected?: number;
  production?: number;
}) {
  return (
    <>
      <h1 id="page-title" tabIndex={-1}>
        Recovery
      </h1>
      <p>Backup and redundancy gaps by system, with evidence and coverage.</p>
      <p role="status" aria-live="polite">
        {unprotected} of {production} production systems lack backup
      </p>
      <table>
        <caption>Recovery gaps</caption>
        <thead>
          <tr>
            <th scope="col">System</th>
            <th scope="col">Check</th>
            <th scope="col">Evidence</th>
            <th scope="col">Coverage</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row">{row.system}</th>
              <td>{row.checkId}</td>
              <td>{row.evidence}</td>
              <td>{row.coverage}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
