import { useId, useState, type FormEvent } from "react";
import type { Cloud } from "@farside/scan-contracts";
import type { RoleGap } from "./data/types";
import {
  CONNECT_STEPS,
  GCP_CONNECT_STEPS,
  OPTIONAL_GCP_ROLES,
  REQUIRED_AZURE_ROLES,
  REQUIRED_GCP_ROLES,
} from "./connect-data";
import { useScans, useSource } from "./data/context";
import { failureMessage, toDataError } from "./data/error";
import { FieldError, fieldProps } from "./form";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GUID_ERROR = "Enter a GUID, for example 00000000-0000-0000-0000-000000000000.";
const GCP_ORG = /^\d{1,20}$/;
const GCP_PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

type Target = {
  title: string;
  roles: readonly string[];
  optionalRoles: readonly string[];
  steps: readonly string[];
  first: { label: string; test: RegExp; error: string };
  second: { label: string; test: RegExp; error: string };
  submit: string;
};

const TARGETS: Record<Cloud, Target> = {
  azure: {
    title: "Connect Azure",
    roles: REQUIRED_AZURE_ROLES,
    optionalRoles: [],
    steps: CONNECT_STEPS,
    first: { label: "Azure tenant id", test: GUID, error: GUID_ERROR },
    second: { label: "Azure subscription id", test: GUID, error: GUID_ERROR },
    submit: "Connect subscription",
  },
  gcp: {
    title: "Connect GCP",
    roles: REQUIRED_GCP_ROLES,
    optionalRoles: OPTIONAL_GCP_ROLES,
    steps: GCP_CONNECT_STEPS,
    first: {
      label: "GCP organization id",
      test: GCP_ORG,
      error: "Enter the numeric organization id, for example 123456789012.",
    },
    second: {
      label: "GCP project id",
      test: GCP_PROJECT,
      error:
        "Enter a project id: 6 to 30 lowercase letters, digits or hyphens, for example my-project-1.",
    },
    submit: "Connect project",
  },
};

type Errors = { tenantId?: string; subscriptionId?: string };

function Gaps({ gaps }: { gaps: RoleGap[] | null | undefined }) {
  if (gaps === undefined) {
    return null;
  }
  if (gaps === null) {
    return <p className="notice">Roles could not be checked yet. Try again after the scan.</p>;
  }
  if (gaps.length === 0) {
    return <p className="notice">All required roles are in place.</p>;
  }
  return (
    <div className="notice">
      <p>Missing roles. Checks that need them are not assessed until you grant them.</p>
      <ul>
        {gaps.map((gap) => (
          <li key={gap.role}>
            {gap.role} {gap.required ? "(required)" : "(optional)"}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Connect() {
  const source = useSource();
  const { refresh: refreshScans } = useScans();
  const tenantFieldId = useId();
  const subscriptionFieldId = useId();
  const [cloud, setCloud] = useState<Cloud>("azure");
  const [gaps, setGaps] = useState<RoleGap[] | null | undefined>(undefined);
  const target = TARGETS[cloud];
  const cloudFieldId = useId();
  const [tenantId, setTenantId] = useState("");
  const [subscriptionId, setSubscriptionId] = useState("");
  const [status, setStatus] = useState("");
  const [connected, setConnected] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState("");
  const [connecting, setConnecting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const tenant = tenantId.trim();
    const subscription = subscriptionId.trim();
    const found: Errors = {
      ...(target.first.test.test(tenant) ? {} : { tenantId: target.first.error }),
      ...(target.second.test.test(subscription) ? {} : { subscriptionId: target.second.error }),
    };
    setErrors(found);
    setStatus("");
    setFailure("");
    setConnected(false);
    setGaps(undefined);
    if (found.tenantId || found.subscriptionId) {
      document.getElementById(found.tenantId ? tenantFieldId : subscriptionFieldId)?.focus();
      return;
    }
    setConnecting(true);
    try {
      const result = await source.connect({
        tenantId: tenant,
        subscriptionId: subscription,
        ...(cloud === "gcp" ? { cloud } : {}),
      });
      setGaps(result.roleGaps);
      const summary =
        cloud === "gcp"
          ? `Connected organization ${tenant} and project ${subscription}.`
          : `Connected tenant ${tenant} and subscription ${subscription}.`;
      setStatus(
        result.scanStarted
          ? `${summary} First scan started.`
          : (result.attention ?? `${summary} No scan was started.`),
      );
      setConnected(true);
      refreshScans();
    } catch (error) {
      setFailure(failureMessage(toDataError(error), "connect this subscription"));
    } finally {
      setConnecting(false);
    }
  }

  return (
    <>
      <h1 className="page-title" id="page-title" tabIndex={-1}>
        {target.title}
      </h1>
      <p className="page-description">
        Farside uses federated credentials. It never asks for a client secret.
      </p>
      <div className="field">
        <label htmlFor={cloudFieldId}>Cloud to connect</label>
        <select
          className="input"
          id={cloudFieldId}
          value={cloud}
          onChange={(event) => {
            setCloud(event.target.value as Cloud);
            setErrors({});
            setStatus("");
            setFailure("");
            setConnected(false);
            setGaps(undefined);
          }}
        >
          <option value="azure">Azure</option>
          <option value="gcp">GCP</option>
        </select>
      </div>
      <h2>Required read-only roles</h2>
      <ul className="tag-list" role="list">
        {target.roles.map((role) => (
          <li className="chip chip-neutral" key={role}>
            {role}
          </li>
        ))}
      </ul>
      {target.optionalRoles.length > 0 ? (
        <>
          <h2>Optional access</h2>
          <ul className="tag-list" role="list">
            {target.optionalRoles.map((role) => (
              <li className="chip chip-neutral" key={role}>
                {role}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {cloud === "gcp" ? (
        <p className="notice">
          These roles come from the Farside GCP spec and have not been verified against a live
          project.
        </p>
      ) : null}
      <h2>Connect steps</h2>
      <ol className="panel step-list">
        {target.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <form className="panel form" onSubmit={onSubmit} noValidate>
        <div className="field">
          <label htmlFor={tenantFieldId}>{target.first.label}</label>
          <input
            className="input"
            id={tenantFieldId}
            name="tenantId"
            type="text"
            autoComplete="off"
            spellCheck={false}
            required
            aria-required="true"
            value={tenantId}
            onChange={(event) => setTenantId(event.target.value)}
            {...fieldProps(tenantFieldId, errors.tenantId)}
          />
          <FieldError id={tenantFieldId} error={errors.tenantId} />
        </div>
        <div className="field">
          <label htmlFor={subscriptionFieldId}>{target.second.label}</label>
          <input
            className="input"
            id={subscriptionFieldId}
            name="subscriptionId"
            type="text"
            autoComplete="off"
            spellCheck={false}
            required
            aria-required="true"
            value={subscriptionId}
            onChange={(event) => setSubscriptionId(event.target.value)}
            {...fieldProps(subscriptionFieldId, errors.subscriptionId)}
          />
          <FieldError id={subscriptionFieldId} error={errors.subscriptionId} />
        </div>
        <div>
          <button className="action action-primary" type="submit" disabled={connecting}>
            {connecting ? "Connecting..." : target.submit}
          </button>
        </div>
      </form>
      <p className="notice" role="status" aria-live="polite">
        {status}
        {connected ? (
          <>
            {" "}
            <a href="#scans">View scans</a>
          </>
        ) : null}
      </p>
      {connected ? <Gaps gaps={gaps} /> : null}
      {failure ? (
        <p className="notice notice-alert" role="alert">
          {failure}
        </p>
      ) : null}
    </>
  );
}
