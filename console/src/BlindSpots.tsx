import { BLIND_SPOT_HEALTH, BLIND_SPOT_ROWS, HEALTH_SCORE_FORMULA, type BlindSpot } from "./blind-spots";

export function BlindSpots({
  spots = BLIND_SPOT_ROWS,
  leftOut = BLIND_SPOT_HEALTH.unassessedScopes,
  total = BLIND_SPOT_HEALTH.assessedScopes + BLIND_SPOT_HEALTH.unassessedScopes,
  formula = HEALTH_SCORE_FORMULA,
}: {
  spots?: BlindSpot[];
  leftOut?: number;
  total?: number;
  formula?: string;
}) {
  return (
    <>
      <h1 id="page-title" tabIndex={-1}>
        Blind spots
      </h1>
      <p>
        Farside does not treat silence as health. Unassessed scopes are left out of the score.
      </p>
      <p>{formula}</p>
      <p role="status" aria-live="polite">
        {leftOut} of {total} scopes were left out of the score.
      </p>
      <table>
        <caption>What Farside could not check</caption>
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col">Why it was not checked</th>
            <th scope="col">What would close it</th>
          </tr>
        </thead>
        <tbody>
          {spots.map((spot) => (
            <tr key={spot.id}>
              <th scope="row">{spot.checkId}</th>
              <td>{spot.reason}</td>
              <td>{spot.closer}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
