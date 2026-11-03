import { Chip, coverageTone } from "./Chip";
import { useOverview, useSource } from "./data/context";
import type { RecoveryView } from "./data/types";
import { useResource } from "./data/use-resource";
import { LastScan } from "./LastScan";
import { inventoryHref } from "./links";
import { ScreenState, gapsMessage } from "./ScreenState";
import { TERMS, coverageStateLabel, shortName } from "./terms";

function backupSummary({
  unprotected,
  checked,
  undetermined,
}: RecoveryView): string {
  if (undetermined === 0) {
    return `${unprotected} of ${checked} production systems lack backup`;
  }
  const unchecked = `${undetermined} could not be checked`;
  return checked === 0
    ? `${unchecked} for backup`
    : `${unprotected} of ${checked} checked lack backup; ${unchecked}`;
}

export function Recovery() {
  const source = useSource();
  const overview = useOverview();
  const view = useResource((signal) => source.recovery(signal), [source]);
  return (
    <>
      <h1 className="page-title" id="page-title" tabIndex={-1}>
        Recovery
      </h1>
      <p className="page-description">
        Backup and redundancy gaps by system, with evidence and coverage.
      </p>
      <LastScan />
      <ScreenState
        label="recovery gaps"
        resource={view}
        partial
        empty={(data) =>
          data.rows.length === 0
            ? gapsMessage(
                overview,
                `No backup or redundancy gaps were found on the scopes that were ${TERMS.assessed}.`,
              )
            : null
        }
      >
        {(data) => (
          <>
            <p className="page-meta" role="status" aria-live="polite">
              {backupSummary(data)}
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
                      <th scope="row">
                        <a href={inventoryHref(row.system)} title={row.system}>
                          {shortName(row.system)}
                        </a>
                      </th>
                      <td>{row.checkId}</td>
                      <td>{row.evidence}</td>
                      <td>
                        <Chip tone={coverageTone(row.coverage)}>
                          {coverageStateLabel(row.coverage)}
                        </Chip>
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
