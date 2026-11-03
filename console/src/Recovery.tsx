import { Chip, coverageTone } from "./Chip";
import { useSource } from "./data/context";
import { useResource } from "./data/use-resource";
import { ScreenState } from "./ScreenState";

export function Recovery() {
  const source = useSource();
  const view = useResource((signal) => source.recovery(signal), [source]);
  return (
    <>
      <h1 className="page-title" id="page-title" tabIndex={-1}>
        Recovery
      </h1>
      <p className="page-description">
        Backup and redundancy gaps by system, with evidence and coverage.
      </p>
      <ScreenState
        label="recovery gaps"
        resource={view}
        partial
        empty={(data) =>
          data.rows.length === 0
            ? "No backup or redundancy gaps were found on the scopes that were assessed."
            : null
        }
      >
        {(data) => (
          <>
            <p className="page-meta" role="status" aria-live="polite">
              {data.unprotected} of {data.production} production systems lack backup
            </p>
            <div
              className="table-wrap"
              role="region"
              aria-labelledby="recovery-caption"
              tabIndex={0}
            >
              <table>
                <caption id="recovery-caption">Recovery gaps</caption>
                <thead>
                  <tr>
                    <th scope="col">System</th>
                    <th scope="col">Check</th>
                    <th scope="col">Evidence</th>
                    <th scope="col">Coverage</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.id}>
                      <th scope="row">{row.system}</th>
                      <td>{row.checkId}</td>
                      <td>{row.evidence}</td>
                      <td>
                        <Chip tone={coverageTone(row.coverage)}>{row.coverage}</Chip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </ScreenState>
    </>
  );
}
