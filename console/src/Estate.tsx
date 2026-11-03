import { useOverview } from "./data/context";
import { ScreenState } from "./ScreenState";

export function Estate() {
  const overview = useOverview();
  return (
    <>
      <h1 className="page-title" id="page-title" tabIndex={-1}>
        Estate
      </h1>
      <ScreenState
        label="the estate overview"
        resource={overview}
        empty={(data) =>
          data.empty ? (
            <>
              Nothing scanned yet. <a href="#connect">Connect a cloud estate</a> to see inventory
              and coverage.
            </>
          ) : null
        }
      >
        {(data) => (
          <>
            <ul className="stats" role="list">
              <li className="stat">Resources {data.resourceTotal}</li>
              <li className="stat">No owner {data.noOwnerTotal}</li>
              <li className="stat">Assessed scopes {data.coverage.assessed}</li>
              <li className="stat">Unassessed scopes {data.coverage.unassessed}</li>
              <li className="stat">Undetermined scopes {data.coverage.undetermined}</li>
            </ul>
            {data.healthScore == null ? (
              <p className="page-description">
                There is no health score until checks produce findings on assessed scopes.
              </p>
            ) : (
              <>
                <p className="stat stat-score">Health score {Math.round(data.healthScore)}</p>
                <p className="page-description">
                  Score uses only assessed scopes. Unassessed scopes are left out of the score.
                </p>
              </>
            )}
            <p>
              <a href="#blind-spots">Blind spots summary</a>
            </p>
          </>
        )}
      </ScreenState>
    </>
  );
}
