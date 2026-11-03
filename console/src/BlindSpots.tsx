import { useSource } from "./data/context";
import { useResource } from "./data/use-resource";
import { LastScan } from "./LastScan";
import { ScreenState } from "./ScreenState";
import { TERMS, coverageStateLabel } from "./terms";

function closerLink(closer: string) {
  if (/\b(grant|role|permission)/i.test(closer)) {
    return <a href="#connect">Open Connect</a>;
  }
  return /\bscan\b/i.test(closer) ? <a href="#scans">Open Scans</a> : null;
}

export function BlindSpots() {
  const source = useSource();
  const view = useResource((signal) => source.blindSpots(signal), [source]);
  return (
    <>
      <h1 className="page-title" id="page-title" tabIndex={-1}>
        Blind spots
      </h1>
      <p className="page-description">
        Farside does not treat silence as health. Scopes that were {TERMS.notAssessed} are left out
        of the score.
      </p>
      <LastScan />
      <ScreenState
        label="blind spots"
        resource={view}
        empty={(data) =>
          data.total === 0
            ? "No scopes have been checked yet. Connect a cloud estate and run a scan."
            : data.spots.length === 0
              ? `Every scope was ${TERMS.assessed}. Nothing was left out of the score.`
              : null
        }
      >
        {(data) => (
          <>
            <p className="page-description">{data.formula}</p>
            <p className="page-meta" role="status" aria-live="polite">
              {data.leftOut} of {data.total} scopes were left out of the score.
            </p>
            <div
              className="table-wrap"
              role="region"
              aria-labelledby="blind-spots-caption"
              tabIndex={0}
            >
              <table>
                <caption id="blind-spots-caption">What Farside could not check</caption>
                <thead>
                  <tr>
                    <th scope="col">Check</th>
                    <th scope="col">State</th>
                    <th scope="col">Why it was not checked</th>
                    <th scope="col">What would close it</th>
                  </tr>
                </thead>
                <tbody>
                  {data.spots.map((spot) => (
                    <tr key={spot.id}>
                      <th scope="row">{spot.checkId}</th>
                      <td>{coverageStateLabel(spot.state)}</td>
                      <td>{spot.reason}</td>
                      <td>
                        {spot.closer} {closerLink(spot.closer)}
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
