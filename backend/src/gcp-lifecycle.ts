import { defineGcpCheck, fail, nonEmptyStr, num, pass, str, undetermined } from "./checks/define.js";

export const GCP_EXPIRING_CERTS = "gcp-lifecycle-expiring-certs";
export const CERT_TYPE = "certificatemanager.googleapis.com/Certificate";

export const checkGcpExpiringCerts = defineGcpCheck({
  checkId: GCP_EXPIRING_CERTS,
  resourceType: CERT_TYPE,
  readFacts: (certificate, fields, settings) => ({
    threshold: settings.certExpiryFlagDays,
    certificateId: nonEmptyStr(fields, "certificateId") ?? certificate.displayName,
    expireTime: str(fields, "expireTime"),
    daysRemaining: num(fields, "daysRemaining"),
  }),
  decide: ({ threshold, certificateId, expireTime, daysRemaining }, { resource }) => {
    const evidence = {
      resourceUri: resource.resourceUri,
      certificateId,
      expireTime,
      daysRemaining,
      flagDays: threshold,
    };
    if (!(threshold > 0)) {
      return undetermined("Set certificate expiry warning days in Settings", {
        ...evidence,
        daysRemaining: null,
        flagDays: null,
      });
    }
    if (daysRemaining === null) {
      return undetermined("A Certificate Manager read that includes expireTime", evidence);
    }
    return daysRemaining <= threshold ? fail(evidence) : pass(evidence);
  },
});
