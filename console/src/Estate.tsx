import { EMPTY_OVERVIEW, type EstateOverview } from "./estate-data";

export function Estate({ overview = EMPTY_OVERVIEW }: { overview?: EstateOverview }) {
  return (
    <>
      <h1 className="page-title" id="page-title" tabIndex={-1}>
        Estate
      </h1>
      {overview.empty ? (
        <p className="screen-state">
          Nothing scanned yet. <a href="#connect">Connect a cloud estate</a> to see inventory and
          coverage.
        </p>
      ) : (
        <>
          <ul className="stats">
            <li className="stat">Resources {overview.resourceTotal}</li>
            <li className="stat">No owner {overview.noOwnerTotal}</li>
            <li className="stat">Assessed scopes {overview.coverage.assessed}</li>
            <li className="stat">Unassessed scopes {overview.coverage.unassessed}</li>
            <li className="stat">Undetermined scopes {overview.coverage.undetermined}</li>
          </ul>
          {overview.healthScore == null ? (
            <p className="page-description">
              There is no health score until checks produce findings on assessed scopes.
            </p>
          ) : (
            <>
              <p className="stat stat-score">Health score {overview.healthScore}</p>
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
    </>
  );
}
