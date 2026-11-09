#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Seeds the GCP test project from docs/gcp/ground-truth.json with gcloud, bq and openssl.
 * Dry run by default. Applies only with --apply, GCP credentials and FARSIDE_GCP_SEED_PROJECT.
 * Not run against a live project yet.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = join(ROOT, "docs/gcp/ground-truth.json");
const LIVE_SEED_PATH = join(ROOT, "docs/gcp/live-seed.json");

export const SKIPPED_NO_CREDENTIALS = "skipped: no GCP credentials";

export const SERVICES = [
  "compute.googleapis.com",
  "sqladmin.googleapis.com",
  "container.googleapis.com",
  "certificatemanager.googleapis.com",
  "cloudasset.googleapis.com",
  "recommender.googleapis.com",
  "bigquery.googleapis.com",
  "billingbudgets.googleapis.com",
  "iamcredentials.googleapis.com",
  "sts.googleapis.com",
  "cloudresourcemanager.googleapis.com",
];

export function loadManifest(path = MANIFEST_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadLiveSeed(path = LIVE_SEED_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** ADC file, GOOGLE_APPLICATION_CREDENTIALS, or a gcloud credential store. */
export function hasGcpCredentials(env = process.env, exists = existsSync) {
  const adc = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (typeof adc === "string" && adc.length > 0 && exists(adc)) {
    return true;
  }
  const config = env.CLOUDSDK_CONFIG || join(env.HOME || homedir(), ".config/gcloud");
  return (
    exists(join(config, "application_default_credentials.json")) ||
    exists(join(config, "credentials.db"))
  );
}

function labelFlag(labels) {
  const pairs = Object.entries(labels ?? {}).map(([key, value]) => `${key}=${value}`);
  return pairs.length > 0 ? [`--labels=${pairs.join(",")}`] : [];
}

function zoneOf(item) {
  return /-[a-z]$/.test(item.region) ? item.region : `${item.region}-a`;
}

function step(id, phase, tool, args, extra = {}) {
  return { id, phase, tool, args, ...extra };
}

function itemSteps(item, project, ctx) {
  const p = `--project=${project}`;
  const labels = labelFlag(item.labels);
  const props = item.properties ?? {};
  switch (item.type) {
    case "compute.googleapis.com/Instance":
      return [
        step(item.id, "base", "gcloud", [
          "compute",
          "instances",
          "create",
          item.id,
          p,
          `--zone=${zoneOf(item)}`,
          "--machine-type=e2-micro",
          "--image-family=debian-12",
          "--image-project=debian-cloud",
          ...labels,
          ...(item.id === ctx.boundVm && ctx.boundAddress ? [`--address=${ctx.boundAddress}`] : []),
        ]),
        // The boot disk shares the VM name and does not inherit VM labels.
        ...(labels.length > 0
          ? [
              step(`${item.id}-boot-labels`, "base", "gcloud", [
                "compute",
                "disks",
                "add-labels",
                item.id,
                p,
                `--zone=${zoneOf(item)}`,
                labels[0],
              ]),
            ]
          : []),
      ];
    case "compute.googleapis.com/Disk": {
      const create = step(item.id, "base", "gcloud", [
        "compute",
        "disks",
        "create",
        item.id,
        p,
        `--zone=${zoneOf(item)}`,
        `--size=${props.sizeGb ?? 10}GB`,
        ...labels,
      ]);
      return props.usersCount > 0
        ? [
            create,
            step(`${item.id}-attach`, "base", "gcloud", [
              "compute",
              "instances",
              "attach-disk",
              ctx.boundVm,
              `--disk=${item.id}`,
              p,
              `--zone=${zoneOf(item)}`,
            ]),
          ]
        : [create];
    }
    case "compute.googleapis.com/Address":
      return [
        step(item.id, "base", "gcloud", [
          "compute",
          "addresses",
          "create",
          item.id,
          p,
          `--region=${item.region}`,
        ]),
        ...(labels.length > 0
          ? [
              step(`${item.id}-labels`, "base", "gcloud", [
                "compute",
                "addresses",
                "update",
                item.id,
                p,
                `--region=${item.region}`,
                labels[0].replace("--labels=", "--update-labels="),
              ]),
            ]
          : []),
      ];
    case "compute.googleapis.com/Snapshot":
      return [
        step(item.id, ctx.phaseOf(item), "gcloud", [
          "compute",
          "snapshots",
          "create",
          item.id,
          p,
          `--source-disk=${ctx.snapshotSource}`,
          `--source-disk-zone=${ctx.snapshotSourceZone}`,
          ...labels,
        ]),
      ];
    case "compute.googleapis.com/Image":
      return [
        step(item.id, ctx.phaseOf(item), "gcloud", [
          "compute",
          "images",
          "create",
          item.id,
          p,
          "--source-image-family=debian-12",
          "--source-image-project=debian-cloud",
          ...labels,
        ]),
      ];
    case "sqladmin.googleapis.com/Instance": {
      const regional = props.availabilityType === "REGIONAL";
      return [
        step(
          item.id,
          "base",
          "gcloud",
          [
            "sql",
            "instances",
            "create",
            item.id,
            p,
            `--region=${item.region}`,
            `--database-version=${props.databaseVersion}`,
            "--edition=ENTERPRISE",
            "--tier=db-custom-1-3840",
            `--availability-type=${regional ? "regional" : "zonal"}`,
            ...(props.backupEnabled
              ? ["--backup-start-time=03:00", ...(regional ? ["--enable-bin-log"] : [])]
              : ["--no-backup"]),
            ...labels,
          ],
          props.databaseVersion === "MYSQL_5_6"
            ? { optional: true, note: "Cloud SQL may refuse new MYSQL_5_6 instances." }
            : {},
        ),
      ];
    }
    case "container.googleapis.com/Cluster":
      return [
        step(item.id, "base", "gcloud", [
          "container",
          "clusters",
          "create-auto",
          item.id,
          p,
          `--region=${item.region}`,
          ...labels,
        ]),
      ];
    case "certificatemanager.googleapis.com/Certificate": {
      const days = Number(props.daysRemaining) > 60 ? 400 : 30;
      const key = join("{tmp}", `${item.id}.key`);
      const crt = join("{tmp}", `${item.id}.crt`);
      return [
        step(
          `${item.id}-pem`,
          "fresh",
          "openssl",
          [
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            key,
            "-out",
            crt,
            "-days",
            String(days),
            "-subj",
            `/CN=${item.id}.invalid`,
          ],
          { note: "Throwaway self-signed key, deleted after apply." },
        ),
        step(item.id, "fresh", "gcloud", [
          "certificate-manager",
          "certificates",
          "create",
          item.id,
          p,
          "--location=global",
          `--certificate-file=${crt}`,
          `--private-key-file=${key}`,
          ...labels,
        ]),
      ];
    }
    default:
      return [];
  }
}

/**
 * Ordered seed plan. Phase "base" goes first and must age past snapshotRetentionDays (and give
 * Recommender idle days). Phase "fresh" (in-retention snapshots/images, certificates) goes just
 * before the live run.
 */
export function buildSeedPlan(manifest = loadManifest(), liveSeed = loadLiveSeed(), options = {}) {
  const project = options.project ?? "{project}";
  const billingAccount = options.billingAccount ?? "{billing-account}";
  const unseedable = liveSeed.unseedable ?? {};
  const items = (manifest.items ?? []).filter(
    (item) => item.type !== "recommender.googleapis.com/Recommendation",
  );
  const vm = items.find((item) => item.type === "compute.googleapis.com/Instance");
  const bound = items.find(
    (item) => item.type === "compute.googleapis.com/Address" && item.properties?.usersCount > 0,
  );
  const attached = items.find(
    (item) => item.type === "compute.googleapis.com/Disk" && item.properties?.usersCount > 0,
  );
  const retention = manifest.snapshotRetentionDays ?? 30;
  const ctx = {
    boundVm: vm?.id,
    boundAddress: bound?.id,
    snapshotSource: attached?.id ?? vm?.id,
    snapshotSourceZone: attached ? zoneOf(attached) : vm ? zoneOf(vm) : "us-central1-a",
    phaseOf: (item) => (Number(item.properties?.ageDays) > retention ? "base" : "fresh"),
  };
  const p = `--project=${project}`;
  const budget = liveSeed.budget ?? {
    displayName: "farside-test-guard",
    amount: 50,
    currency: "USD",
    thresholds: [0.5, 0.9, 1],
  };
  const steps = [
    step("enable-services", "setup", "gcloud", ["services", "enable", ...SERVICES, p]),
    step(
      "budget-guard",
      "setup",
      "gcloud",
      [
        "billing",
        "budgets",
        "create",
        `--billing-account=${billingAccount}`,
        `--display-name=${budget.displayName}`,
        `--budget-amount=${budget.amount}${budget.currency}`,
        ...budget.thresholds.map((value) => `--threshold-rule=percent=${value}`),
        `--filter-projects=projects/${project}`,
      ],
      {
        note: "Alerts at each threshold. A budget alerts; it does not stop spend. Tear down after the live run.",
      },
    ),
    step("billing-export-dataset", "setup", "bq", [
      "--location=US",
      "mk",
      "--dataset",
      `${project}:${liveSeed.billingExportDataset ?? "billing_export"}`,
    ]),
    step("billing-export-enable", "setup", "manual", [], {
      note: `Cloud Billing has no API to switch on the BigQuery export. In the console: Billing > Billing export > BigQuery export > Standard usage cost, dataset ${project}.${liveSeed.billingExportDataset ?? "billing_export"}. History starts that day.`,
    }),
  ];
  const ordered = [
    ...items.filter((item) => item.type === "compute.googleapis.com/Address"),
    ...items.filter((item) => item.type === "compute.googleapis.com/Instance"),
    ...items.filter(
      (item) =>
        item.type !== "compute.googleapis.com/Address" &&
        item.type !== "compute.googleapis.com/Instance",
    ),
  ];
  for (const item of ordered) {
    if (unseedable[item.id]) {
      steps.push(step(item.id, "skip", "manual", [], { note: unseedable[item.id] }));
      continue;
    }
    steps.push(...itemSteps(item, project, ctx));
  }
  for (const extra of liveSeed.extraResources ?? []) {
    steps.push(...itemSteps({ ...extra, title: extra.reason, properties: {} }, project, ctx));
  }
  const phase = options.phase ?? "all";
  return phase === "all"
    ? steps
    : steps.filter((entry) => entry.phase === phase || entry.phase === "setup");
}

/** Deletes the seeded resources in reverse dependency order. */
export function buildTeardownPlan(
  manifest = loadManifest(),
  liveSeed = loadLiveSeed(),
  options = {},
) {
  const project = options.project ?? "{project}";
  const p = `--project=${project}`;
  const items = [
    ...(manifest.items ?? []).filter(
      (item) =>
        item.type !== "recommender.googleapis.com/Recommendation" &&
        !(liveSeed.unseedable ?? {})[item.id],
    ),
    ...(liveSeed.extraResources ?? []),
  ];
  const del = {
    "compute.googleapis.com/Instance": (item) => [
      "compute",
      "instances",
      "delete",
      item.id,
      p,
      `--zone=${zoneOf(item)}`,
      "--quiet",
    ],
    "compute.googleapis.com/Disk": (item) => [
      "compute",
      "disks",
      "delete",
      item.id,
      p,
      `--zone=${zoneOf(item)}`,
      "--quiet",
    ],
    "compute.googleapis.com/Address": (item) => [
      "compute",
      "addresses",
      "delete",
      item.id,
      p,
      `--region=${item.region}`,
      "--quiet",
    ],
    "compute.googleapis.com/Snapshot": (item) => [
      "compute",
      "snapshots",
      "delete",
      item.id,
      p,
      "--quiet",
    ],
    "compute.googleapis.com/Image": (item) => [
      "compute",
      "images",
      "delete",
      item.id,
      p,
      "--quiet",
    ],
    "sqladmin.googleapis.com/Instance": (item) => [
      "sql",
      "instances",
      "delete",
      item.id,
      p,
      "--quiet",
    ],
    "container.googleapis.com/Cluster": (item) => [
      "container",
      "clusters",
      "delete",
      item.id,
      p,
      `--region=${item.region}`,
      "--quiet",
    ],
    "certificatemanager.googleapis.com/Certificate": (item) => [
      "certificate-manager",
      "certificates",
      "delete",
      item.id,
      p,
      "--location=global",
      "--quiet",
    ],
  };
  const order = [
    "compute.googleapis.com/Instance",
    "compute.googleapis.com/Snapshot",
    "compute.googleapis.com/Image",
    "compute.googleapis.com/Disk",
    "compute.googleapis.com/Address",
    "sqladmin.googleapis.com/Instance",
    "container.googleapis.com/Cluster",
    "certificatemanager.googleapis.com/Certificate",
  ];
  return order.flatMap((type) =>
    items
      .filter((item) => item.type === type)
      .map((item) =>
        step(`delete-${item.id}`, "teardown", "gcloud", del[type](item), { optional: true }),
      ),
  );
}

export function renderStep(entry) {
  return entry.tool === "manual"
    ? `# ${entry.id}: ${entry.note}`
    : [entry.tool, ...entry.args].join(" ");
}

function parseArgs(argv) {
  const flag = (name) => argv.includes(name);
  const value = (name) => {
    const hit = argv.find((arg) => arg.startsWith(`${name}=`));
    return hit ? hit.slice(name.length + 1) : undefined;
  };
  return {
    apply: flag("--apply"),
    teardown: flag("--teardown"),
    planOnly: flag("--plan"),
    phase: value("--phase") ?? "all",
  };
}

export function runSeed({
  argv = process.argv.slice(2),
  env = process.env,
  exists = existsSync,
  exec = (tool, args) => execFileSync(tool, args, { stdio: "inherit" }),
  out = (line) => console.log(line),
} = {}) {
  const args = parseArgs(argv);
  if (!["all", "base", "fresh"].includes(args.phase)) {
    out("--phase must be all, base or fresh");
    return 2;
  }
  const project = env.FARSIDE_GCP_SEED_PROJECT;
  const options = {
    phase: args.phase,
    ...(project ? { project } : {}),
    ...(env.FARSIDE_GCP_BILLING_ACCOUNT ? { billingAccount: env.FARSIDE_GCP_BILLING_ACCOUNT } : {}),
  };
  const plan = args.teardown
    ? buildTeardownPlan(loadManifest(), loadLiveSeed(), options)
    : buildSeedPlan(loadManifest(), loadLiveSeed(), options);
  if (args.planOnly) {
    plan.forEach((entry) => out(renderStep(entry)));
    return 0;
  }
  if (!hasGcpCredentials(env, exists)) {
    out(SKIPPED_NO_CREDENTIALS);
    out(`seed plan steps: ${plan.length} (print with --plan)`);
    return 0;
  }
  if (!args.apply) {
    out(`dry run: ${plan.length} steps; pass --apply to run them`);
    plan.forEach((entry) => out(renderStep(entry)));
    return 0;
  }
  if (!project || !env.FARSIDE_GCP_BILLING_ACCOUNT) {
    out("--apply needs FARSIDE_GCP_SEED_PROJECT and FARSIDE_GCP_BILLING_ACCOUNT");
    return 2;
  }
  const tmp = mkdtempSync(join(tmpdir(), "farside-gcp-seed-"));
  const failed = [];
  try {
    for (const entry of plan) {
      if (entry.tool === "manual") {
        out(renderStep(entry));
        continue;
      }
      const stepArgs = entry.args.map((arg) => arg.replaceAll("{tmp}", tmp));
      try {
        exec(entry.tool, stepArgs);
      } catch {
        if (!entry.optional) {
          out(`step ${entry.id} failed; stopping`);
          return 1;
        }
        failed.push(entry.id);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (failed.length > 0) {
    out(`optional steps failed: ${failed.join(", ")}`);
  }
  return 0;
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(entry).href === import.meta.url;
}

if (isMain()) {
  process.exit(runSeed());
}
