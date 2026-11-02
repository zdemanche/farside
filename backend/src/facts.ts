import type { GroundTruthItem, GroundTruthManifest } from "./inventory.js";

export type ResourceFacts = {
  resourceUri: string;
  fields: Record<string, string | number | boolean | null>;
};

export function resourceUriFor(item: GroundTruthItem): string {
  return `/subscriptions/${item.subscription}/resourceGroups/farside-seed/providers/${item.type}/${item.id}`;
}

export function factsFromManifest(manifest: GroundTruthManifest): ResourceFacts[] {
  return manifest.items.map((item) => {
    const fields: Record<string, string | number | boolean | null> = {
      location: "eastus",
      ...(item.properties ?? {}),
    };
    if (item.type === "Microsoft.Compute/disks") {
      fields.diskId = item.id;
    }
    if (item.type === "Microsoft.Compute/snapshots") {
      fields.snapshotId = item.id;
    }
    if (item.type === "Microsoft.Network/publicIPAddresses") {
      fields.publicIpId = item.id;
    }
    if (item.type === "Microsoft.Compute/virtualMachines") {
      fields.vmId = item.id;
    }
    if (item.type === "Microsoft.Web/serverfarms") {
      fields.planId = item.id;
    }
    if (item.type === "Microsoft.Network/loadBalancers") {
      fields.loadBalancerId = item.id;
    }
    if (item.type === "Microsoft.Network/natGateways") {
      fields.natGatewayId = item.id;
    }
    return { resourceUri: resourceUriFor(item), fields };
  });
}
