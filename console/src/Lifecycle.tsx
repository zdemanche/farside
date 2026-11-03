import { LIFECYCLE_ROWS, LIFECYCLE_WITHIN_90, type LifecycleRow } from "./lifecycle-data";

export function Lifecycle({
  rows = LIFECYCLE_ROWS,
  within90 = LIFECYCLE_WITHIN_90,
}: {
  rows?: LifecycleRow[];
  within90?: number;
}) {
  return (
    <>
      <h1 className="page-title" id="page-title" tabIndex={-1}>
        Lifecycle
      </h1>
      <p className="page-description">Items losing support or expiring, listed by date.</p>
      <p className="page-meta" role="status" aria-live="polite">
        {within90} things losing support in 90 days
      </p>
      <div className="table-wrap" role="region" aria-labelledby="lifecycle-caption" tabIndex={0}>
        <table>
          <caption id="lifecycle-caption">Lifecycle items by date</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Item</th>
              <th scope="col">Kind</th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.date}</td>
                <th scope="row">{row.title}</th>
                <td>{row.kind}</td>
                <td>{row.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
