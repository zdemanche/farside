import { loadRetiringSkus } from "../retiring.js";
import { defineAzureCheck, fail, num, pass, str, undetermined } from "./define.js";

export const RETIRING_SKUS = "azure-lifecycle-retiring-skus";
export const EXPIRING_APP_CERTS = "azure-lifecycle-expiring-app-service-certs";
export const EXPIRING_GATEWAY_CERTS = "azure-lifecycle-expiring-gateway-certs";

export const checkRetiringSkus = defineAzureCheck({
  checkId: RETIRING_SKUS,
  prepare: () => {
    const catalogue = loadRetiringSkus();
    return { catalogue, bySku: new Map(catalogue.entries.map((entry) => [entry.skuName, entry])) };
  },
  readFacts: (_resource, fields) => str(fields, "skuName") ?? str(fields, "vmSize"),
  decide: (skuName, { resource, shared: { catalogue, bySku } }) => {
    if (skuName === null) {
      return null;
    }
    const identity = {
      resourceUri: resource.resourceUri,
      resourceId: resource.resourceUri.split("/").pop() ?? resource.displayName,
      skuName,
    };
    const listed = bySku.get(skuName);
    if (listed) {
      return fail({
        ...identity,
        retirementDate: listed.retirementDate,
        announcementId: listed.announcementId,
        source: listed.source,
      });
    }
    return pass({
      ...identity,
      catalogueVersion: catalogue.version,
      cataloguePublishedAt: catalogue.publishedAt,
      source: catalogue.source,
    });
  },
});

function expiringCertsCheck(spec: {
  checkId: string;
  resourceType: string;
  idField: "certificateId" | "gatewayId";
  nameField: "hostName" | "certificateName";
}) {
  return defineAzureCheck({
    checkId: spec.checkId,
    resourceType: spec.resourceType,
    readFacts: (resource, fields, settings) => ({
      threshold: settings.certExpiryFlagDays,
      id: str(fields, spec.idField) ?? resource.displayName,
      name: str(fields, spec.nameField),
      expirationDate: str(fields, "expirationDate"),
      daysRemaining: num(fields, "daysRemaining"),
    }),
    decide: ({ threshold, id, name, expirationDate, daysRemaining }, { resource }) => {
      const evidence = (days: number | null) => ({
        resourceUri: resource.resourceUri,
        [spec.idField]: id,
        [spec.nameField]: name,
        expirationDate,
        daysRemaining: days,
      });
      if (!(threshold > 0)) {
        return undetermined("Set certificate expiry warning days in Settings", evidence(null));
      }
      if (daysRemaining === null) {
        return undetermined("A certificate read that includes expirationDate", evidence(null));
      }
      return daysRemaining <= threshold ? fail(evidence(daysRemaining)) : pass(evidence(daysRemaining));
    },
  });
}

export const checkExpiringAppCerts = expiringCertsCheck({
  checkId: EXPIRING_APP_CERTS,
  resourceType: "Microsoft.Web/certificates",
  idField: "certificateId",
  nameField: "hostName",
});

export const checkExpiringGatewayCerts = expiringCertsCheck({
  checkId: EXPIRING_GATEWAY_CERTS,
  resourceType: "Microsoft.Network/applicationGateways",
  idField: "gatewayId",
  nameField: "certificateName",
});
