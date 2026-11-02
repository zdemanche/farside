/**
 * Proposed `PRODUCTS` entry for Moonaan/iac-hub `event/AccountProvisioner.ts`.
 *
 * This file is the in-repo contract only. It is not registered until someone
 * merges it into iac-hub; the hub reads `PRODUCTS` from iac-hub `main`, and
 * this working repository cannot change that list.
 *
 * `targetRepo` is the agreed Moonaan name. Hub dispatch is org-scoped to
 * Moonaan, so it stays blocked until D2/D5 clear the name and the code lives
 * at Moonaan/moonaan-farside (or iac-hub is pointed at the working repo).
 *
 * Stages follow Identity: backend artifacts, infra, then web. Workflows are
 * workflow_dispatch-only so they do not fight the provisioner.
 */
export const FARSIDE_IAC_HUB_PRODUCT = {
  key: "Farside",
  deploymentKey: "farside",
  stages: [
    {
      key: "BackendArtifacts",
      targetRepo: "moonaan-farside",
      workflow: "backend-publish.yml",
      manifest: true,
    },
    {
      key: "Infra",
      targetRepo: "moonaan-farside",
      workflow: "infra-pulumi_up.yaml",
      destroyWorkflow: "infra-pulumi_destroy.yaml",
      manifest: true,
    },
    {
      key: "Web",
      targetRepo: "moonaan-farside",
      workflow: "ui-deploy.yml",
      manifest: true,
    },
  ],
} as const;

export const FARSIDE_ADOPTING_PRODUCTS_EXAMPLE = ["farside"] as const;
