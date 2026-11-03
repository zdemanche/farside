import { useId, useMemo, useState } from "react";
import { useSource } from "./data/context";
import type { InventoryRow } from "./data/types";
import { useResource } from "./data/use-resource";
import { plural } from "./plural";
import { ScreenState } from "./ScreenState";

type Filters = { owner: string; service: string; subscription: string; region: string };

const NO_FILTERS: Filters = { owner: "", service: "", subscription: "", region: "" };

function matches(resource: InventoryRow, filters: Filters): boolean {
  const { owner, service, subscription, region } = filters;
  if (owner === "none" && resource.ownerTag) {
    return false;
  }
  if (owner && owner !== "none" && resource.ownerTag !== owner) {
    return false;
  }
  if (service && resource.resourceType !== service) {
    return false;
  }
  if (subscription && resource.subscriptionOrProject !== subscription) {
    return false;
  }
  if (region && resource.region !== region) {
    return false;
  }
  return true;
}

const distinct = (values: (string | null | undefined)[]) =>
  [...new Set(values.filter((value): value is string => Boolean(value)))].sort();

function InventoryBody({ orgId, resources }: { orgId: string; resources: InventoryRow[] }) {
  const ids = { owner: useId(), service: useId(), subscription: useId(), region: useId() };
  const [filters, setFilters] = useState(NO_FILTERS);
  const filtered = useMemo(
    () => resources.filter((resource) => matches(resource, filters)),
    [resources, filters],
  );
  const options = useMemo(
    () => ({
      owner: distinct(resources.map((resource) => resource.ownerTag)),
      service: distinct(resources.map((resource) => resource.resourceType)),
      subscription: distinct(resources.map((resource) => resource.subscriptionOrProject)),
      region: distinct(resources.map((resource) => resource.region)),
    }),
    [resources],
  );
  const byOwner = new Map<string, number>();
  const byService = new Map<string, number>();
  for (const resource of filtered) {
    const key = resource.ownerTag ?? "none";
    byOwner.set(key, (byOwner.get(key) ?? 0) + 1);
    byService.set(resource.resourceType, (byService.get(resource.resourceType) ?? 0) + 1);
  }
  const change = (key: keyof Filters) => (event: { target: { value: string } }) =>
    setFilters((current) => ({ ...current, [key]: event.target.value }));

  const scopes = options.subscription;
  return (
    <>
      <p className="page-description">
        Org {orgId}
        {scopes.length > 0
          ? ` · ${scopes.length === 1 ? "Subscription" : "Subscriptions"} ${scopes.join(", ")}`
          : ""}
      </p>
      <p className="page-meta" role="status" aria-live="polite">
        {plural(filtered.length, "resource")}
      </p>
      <form className="panel filters" role="search" aria-label="Filter inventory">
        <div className="field">
          <label htmlFor={ids.owner}>Owner</label>
          <select className="input" id={ids.owner} value={filters.owner} onChange={change("owner")}>
            <option value="">Any owner</option>
            <option value="none">No owner</option>
            {options.owner.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.service}>Service</label>
          <select
            className="input"
            id={ids.service}
            value={filters.service}
            onChange={change("service")}
          >
            <option value="">Any service</option>
            {options.service.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.subscription}>Subscription</label>
          <select
            className="input"
            id={ids.subscription}
            value={filters.subscription}
            onChange={change("subscription")}
          >
            <option value="">Any subscription</option>
            {options.subscription.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.region}>Region</label>
          <select
            className="input"
            id={ids.region}
            value={filters.region}
            onChange={change("region")}
          >
            <option value="">Any region</option>
            {options.region.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
      </form>
      {filtered.length === 0 ? (
        <p className="screen-state">
          No resources match these filters.{" "}
          <button
            className="action action-secondary"
            type="button"
            onClick={() => setFilters(NO_FILTERS)}
          >
            Clear filters
          </button>
        </p>
      ) : (
        <>
          <h2>By owner</h2>
          <ul className="tag-list" role="list">
            {[...byOwner.entries()].map(([key, count]) => (
              <li className="chip chip-neutral" key={key}>
                {key} {count}
              </li>
            ))}
          </ul>
          <h2>By service</h2>
          <ul className="tag-list" role="list">
            {[...byService.entries()].map(([key, count]) => (
              <li className="chip chip-neutral" key={key}>
                {key} {count}
              </li>
            ))}
          </ul>
          <div
            className="table-wrap"
            role="region"
            aria-labelledby="inventory-caption"
            tabIndex={0}
          >
            <table>
              <caption id="inventory-caption">Inventory resources</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Service</th>
                  <th scope="col">Subscription</th>
                  <th scope="col">Region</th>
                  <th scope="col">Owner</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((resource) => (
                  <tr key={resource.resourceUri}>
                    <th scope="row">{resource.displayName}</th>
                    <td>{resource.resourceType}</td>
                    <td>{resource.subscriptionOrProject}</td>
                    <td>{resource.region}</td>
                    <td>{resource.ownerTag ?? "none"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

export function Inventory() {
  const source = useSource();
  const resources = useResource((signal) => source.inventory(signal), [source]);
  return (
    <>
      <h1 className="page-title" id="page-title" tabIndex={-1}>
        Inventory
      </h1>
      <ScreenState
        label="the inventory"
        resource={resources}
        partial
        empty={(data) =>
          data.length === 0
            ? "No resources have been inventoried yet. Connect a cloud estate and run a scan."
            : null
        }
      >
        {(data) => <InventoryBody orgId={source.orgId} resources={data} />}
      </ScreenState>
    </>
  );
}
