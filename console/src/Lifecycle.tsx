import { useSource } from "./data/context";
import { useResource } from "./data/use-resource";
import { ScreenState } from "./ScreenState";

export function Lifecycle() {
  const source = useSource();
  const view = useResource((signal) => source.lifecycle(signal), [source]);
  return (
    <>
      <h1 className="page-title" id="page-title" tabIndex={-1}>
        Lifecycle
      </h1>
      <p className="page-description">Items losing support or expiring, listed by date.</p>
      <ScreenState
        label="lifecycle items"
        resource={view}
        partial
        empty={(data) =>
          data.rows.length === 0
            ? "Nothing is losing support or expiring on the scopes that were assessed."
            : null
        }
      >
        {(data) => (
          <>
            <p className="page-meta" role="status" aria-live="polite">
              {data.within90} things losing support in 90 days
            </p>
            <div
              className="table-wrap"
              role="region"
              aria-labelledby="lifecycle-caption"
              tabIndex={0}
            >
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
                  {data.rows.map((row) => (
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
        )}
      </ScreenState>
    </>
  );
}
