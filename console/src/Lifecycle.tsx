import { useOverview, useSource } from "./data/context";
import { useResource } from "./data/use-resource";
import { Time } from "./format";
import { LastScan } from "./LastScan";
import { inventoryHref } from "./links";
import { ScreenState, gapsMessage } from "./ScreenState";
import { plural } from "./plural";
import { TERMS } from "./terms";

export function Lifecycle() {
  const source = useSource();
  const overview = useOverview();
  const view = useResource((signal) => source.lifecycle(signal), [source]);
  return (
    <>
      <h1 className="page-title" id="page-title" tabIndex={-1}>
        Lifecycle
      </h1>
      <p className="page-description">
        Items losing support or expiring, listed by date.
      </p>
      <LastScan />
      <ScreenState
        label="lifecycle items"
        resource={view}
        partial
        empty={(data) =>
          data.rows.length === 0
            ? gapsMessage(
                overview,
                `Nothing is losing support or expiring on the scopes that were ${TERMS.assessed}.`,
              )
            : null
        }
      >
        {(data) => (
          <>
            <p className="page-meta" role="status" aria-live="polite">
              {plural(data.within90, "thing")} losing support in 90 days
            </p>
            <div
              className="table-wrap"
              role="region"
              aria-labelledby="lifecycle-caption"
              tabIndex={0}
            >
              <table>
                <caption id="lifecycle-caption">
                  Lifecycle items by date
                </caption>
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
                      <td>
                        <Time value={row.date} dateOnly />
                      </td>
                      <th scope="row">
                        <a href={inventoryHref(row.resourceId)}>{row.title}</a>
                      </th>
                      <td>{row.kind}</td>
                      <td>
                        {row.source.href ? (
                          <a href={row.source.href}>{row.source.vendor}</a>
                        ) : (
                          row.source.vendor
                        )}
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
