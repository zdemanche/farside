export const COVERAGE_CAUSES = {
  missing_role: {
    reason:
      "Farside is missing a required Azure role on this subscription, so this check did not finish.",
    closer: "Grant the missing read-only role listed on Connect, then run a scan.",
  },
  throttling: {
    reason: "Azure throttled the API call for this check, so Farside stopped short of a result.",
    closer: "Wait and run the scan again. The next unattended run will retry.",
  },
  unsupported_type: {
    reason: "This resource type is not on the current Farside support matrix.",
    closer: "A dated live run that marks the check verified in the Azure spec.",
  },
  failed_call: {
    reason: "The Azure call for this check failed before Farside could collect evidence.",
    closer: "A successful API response for this check on the subscription.",
  },
  not_run: {
    reason: "This check has not run on this subscription yet.",
    closer: "Run a scan after connect, or wait for the unattended scan.",
  },
} as const;

export type CoverageCauseId = keyof typeof COVERAGE_CAUSES;
