import { useMemo, useState } from "react";
import { SEEDED_RESOURCES } from "./estate-data";
import type { InventoryRecord } from "@farside/scan-contracts";

function matches(
  resource: InventoryRecord,
  owner: string,
  service: string,
  subscription: string,
  region: string,
): boolean {
  if (owner === "none" && resource.ownerTag) {
    return false;
  }
  if (owner && owner !== "none" && resource.ownerTag !== owner) {
    return false;
  }
  if (service && resource.resourceType !== service) {
    return false;
  }
  if (subscription && !resource.resourceUri.includes(`/subscriptions/${subscription}/`)) {
    return false;
  }
  if (region && resource.region !== region) {
    return false;
  }
  return true;
}

export function Inventory({ resources = SEEDED_RESOURCES }: { resources?: InventoryRecord[] }) {
  const [owner, setOwner] = useState("");
  const [service, setService] = useState("");
  const [subscription, setSubscription] = useState("");
  const [region, setRegion] = useState("");
  const filtered = useMemo(
    () => resources.filter((resource) => matches(resource, owner, service, subscription, region)),
    [resources, owner, service, subscription, region],
  );
  const byOwner = new Map<string, number>();
  const byService = new Map<string, number>();
  for (const resource of filtered) {
    const key = resource.ownerTag ?? "none";
    byOwner.set(key, (byOwner.get(key) ?? 0) + 1);
    byService.set(resource.resourceType, (byService.get(resource.resourceType) ?? 0) + 1);
  }

  return (
    <>
      <h1 className="page-title" id="page-title" tabIndex={-1}>
        Inventory
      </h1>
      <p className="page-meta" role="status" aria-live="polite">
        {filtered.length} resources
      </p>
      <form className="panel filters">
        <div className="field">
          <label htmlFor="filter-owner">Owner</label>
          <select
            className="input"
            id="filter-owner"
            value={owner}
            onChange={(event) => setOwner(event.target.value)}
          >
            <option value="">Any owner</option>
            <option value="none">No owner</option>
            <option value="farside-test">farside-test</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="filter-service">Service</label>
          <select
            className="input"
            id="filter-service"
            value={service}
            onChange={(event) => setService(event.target.value)}
          >
            <option value="">Any service</option>
            <option value="Microsoft.Compute/disks">Microsoft.Compute/disks</option>
            <option value="Microsoft.Compute/virtualMachines">
              Microsoft.Compute/virtualMachines
            </option>
            <option value="Microsoft.Network/publicIPAddresses">
              Microsoft.Network/publicIPAddresses
            </option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="filter-subscription">Subscription</label>
          <select
            className="input"
            id="filter-subscription"
            value={subscription}
            onChange={(event) => setSubscription(event.target.value)}
          >
            <option value="">Any subscription</option>
            <option value="main">main</option>
            <option value="empty-no-budget">empty-no-budget</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="filter-region">Region</label>
          <select
            className="input"
            id="filter-region"
            value={region}
            onChange={(event) => setRegion(event.target.value)}
          >
            <option value="">Any region</option>
            <option value="eastus">eastus</option>
            <option value="westus">westus</option>
          </select>
        </div>
      </form>
      <h2>By owner</h2>
      <ul className="tag-list">
        {[...byOwner.entries()].map(([key, count]) => (
          <li className="chip chip-neutral" key={key}>
            {key} {count}
          </li>
        ))}
      </ul>
      <h2>By service</h2>
      <ul className="tag-list">
        {[...byService.entries()].map(([key, count]) => (
          <li className="chip chip-neutral" key={key}>
            {key} {count}
          </li>
        ))}
      </ul>
      <div className="table-wrap" tabIndex={0}>
        <table>
          <caption>Inventory resources</caption>
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
                <td>{resource.resourceUri.split("/")[2]}</td>
                <td>{resource.region}</td>
                <td>{resource.ownerTag ?? "none"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
