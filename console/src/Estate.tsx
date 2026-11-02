import { EMPTY_OVERVIEW, type EstateOverview } from "./estate-data";

export function Estate({ overview = EMPTY_OVERVIEW }: { overview?: EstateOverview }) {
  return (
    <>
      <h1 id="page-title" tabIndex={-1}>
        Estate
      </h1>
      {overview.empty ? (
        <p>
          Nothing scanned yet. <a href="#connect">Connect a cloud estate</a> to see inventory and
          coverage.
        </p>
      ) : (
        <>
          <ul>
            <li>Resources {overview.resourceTotal}</li>
            <li>No owner {overview.noOwnerTotal}</li>
            <li>Assessed scopes {overview.coverage.assessed}</li>
            <li>Unassessed scopes {overview.coverage.unassessed}</li>
            <li>Undetermined scopes {overview.coverage.undetermined}</li>
          </ul>
          <p>Phase 1 shows coverage only. There is no health score until checks produce findings.</p>
          <p>
            <a href="#blind-spots">Blind spots summary</a>
          </p>
        </>
      )}
    </>
  );
}
