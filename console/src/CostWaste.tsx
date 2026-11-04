import { useSource } from "./data/context";
import type { CostWasteView } from "./data/types";
import { useResource } from "./data/use-resource";
import { ExportButton } from "./ExportButton";
import { LastScan } from "./LastScan";
import { ScreenState } from "./ScreenState";
import { plural } from "./plural";
import { TERMS, shortName } from "./terms";

function money(amount: string, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      currencyDisplay: "code",
    }).format(Number(amount));
  } catch {
    return `${amount} ${currency}`;
  }
}

function range(min: string, max: string, currency: string): string {
  return `${money(min, currency)} to ${money(max, currency)} per month`;
}

function Spend({ spend }: { spend: NonNullable<CostWasteView["spend"]> }) {
  return (
    <section aria-labelledby="spend-title">
      <h2 id="spend-title">Spend by service</h2>
      <p className="page-meta">
        {spend.periodStart} to {spend.periodEnd}
        {spend.provisionalDate ? `, provisional from ${spend.provisionalDate}` : ""}
      </p>
      <div className="table-wrap" role="region" aria-labelledby="spend-caption" tabIndex={0}>
        <table>
          <caption id="spend-caption">Monthly cost per service</caption>
          <thead>
            <tr>
              <th scope="col">Service</th>
              <th scope="col">Cost</th>
              <th scope="col">Change on last month</th>
            </tr>
          </thead>
          <tbody>
            {spend.services.map((service) => {
              const change = spend.monthOnMonth.find(
                (row) => row.serviceName === service.serviceName,
              );
              return (
                <tr key={service.serviceName}>
                  <th scope="row">{service.serviceName}</th>
                  <td>
                    {money(service.costAmount, spend.currency)}
                    {service.provisional ? " (provisional)" : ""}
                  </td>
                  <td>
                    {change
                      ? `${money(change.deltaAmount, spend.currency)} (${change.deltaPercent}%)`
                      : "no prior month"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FloorBurst({ points }: { points: NonNullable<CostWasteView["floorBurst"]> }) {
  const latest = points[points.length - 1];
  return (
    <section aria-labelledby="floor-title">
      <h2 id="floor-title">Floor and burst</h2>
      {latest ? (
        <p>
          On {latest.date} spend was {money(latest.actual, latest.currency)}: a floor of{" "}
          {money(latest.floor, latest.currency)} and a burst of{" "}
          {money(latest.burst, latest.currency)}.
        </p>
      ) : (
        <p>There is not enough daily history to show a floor and burst yet.</p>
      )}
    </section>
  );
}

function Commitments({ commitments }: { commitments: NonNullable<CostWasteView["commitments"]> }) {
  const none = commitments.noneFound.reservations && commitments.noneFound.savingsPlans;
  return (
    <section aria-labelledby="commit-title">
      <h2 id="commit-title">Commitment use</h2>
      <p>
        {none
          ? "No reservations or savings plans were found."
          : `${plural(commitments.reservations.length, "reservation")} and ${plural(commitments.savingsPlans.length, "savings plan")} found.`}
        {commitments.harvestStatus === "unverified" ? " Not verified against a live run." : ""}
      </p>
    </section>
  );
}

function Waste({ view }: { view: CostWasteView }) {
  const { totals } = view;
  return (
    <section aria-labelledby="waste-title">
      <h2 id="waste-title">Waste Farside can name</h2>
      <p>
        {totals.assessedCount === 0
          ? "No waste was found on scopes that were " + TERMS.assessed + "."
          : `${range(totals.min, totals.max, totals.currency)} from ${plural(totals.assessedCount, "finding")} on ${TERMS.assessed} scopes.`}{" "}
        {totals.unassessedScopes > 0 ? (
          <>
            {plural(totals.unassessedScopes, "scope")} {TERMS.notAssessed}, so this is a lower
            bound. <a href="#blind-spots">See blind spots</a>
          </>
        ) : null}
      </p>
      {view.waste.length > 0 ? (
        <div className="table-wrap" role="region" aria-labelledby="waste-caption" tabIndex={0}>
          <table>
            <caption id="waste-caption">Named waste resources</caption>
            <thead>
              <tr>
                <th scope="col">Resource</th>
                <th scope="col">Check</th>
                <th scope="col">Savings</th>
                <th scope="col">Issue</th>
              </tr>
            </thead>
            <tbody>
              {view.waste.map((item) => (
                <tr key={`${item.checkId}:${item.resourceId}`}>
                  <th scope="row" title={item.resourceId}>
                    {shortName(item.resourceId)}
                  </th>
                  <td>{item.checkId}</td>
                  <td>{range(item.savings.min, item.savings.max, item.savings.currency)}</td>
                  <td>
                    <a href={item.issueHref}>View issue</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

export function CostWaste() {
  const source = useSource();
  const view = useResource((signal) => source.costWaste(signal), [source]);
  return (
    <>
      <h1 className="page-title" id="page-title" tabIndex={-1}>
        Cost and waste
      </h1>
      <p className="page-description">
        What the estate costs and the waste Farside can name. Waste totals use only scopes that were{" "}
        {TERMS.assessed}.
      </p>
      <LastScan />
      <ExportButton kind="cost" label="Export cost" />
      <ScreenState label="cost and waste" resource={view} partial>
        {(data) =>
          data.readable && data.spend ? (
            <>
              <Spend spend={data.spend} />
              {data.floorBurst ? <FloorBurst points={data.floorBurst} /> : null}
              {data.commitments ? <Commitments commitments={data.commitments} /> : null}
              <Waste view={data} />
            </>
          ) : (
            <p className="screen-state" role="alert">
              Cost could not be read
              {data.reason && data.reason !== "cost could not be read" ? `: ${data.reason}` : ""}.
              No figures are shown. <a href="#blind-spots">See blind spots</a>
            </p>
          )
        }
      </ScreenState>
    </>
  );
}
