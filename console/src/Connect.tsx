import { useId, useState, type FormEvent } from "react";
import { CONNECT_STEPS, REQUIRED_AZURE_ROLES } from "./connect-data";
import { useSource } from "./data/context";
import { failureMessage, toDataError } from "./data/error";
import { FieldError, fieldProps } from "./form";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GUID_ERROR =
  "Enter a GUID, for example 00000000-0000-0000-0000-000000000000.";

type Errors = { tenantId?: string; subscriptionId?: string };

export function Connect() {
  const source = useSource();
  const tenantFieldId = useId();
  const subscriptionFieldId = useId();
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
      ...(GUID.test(tenant) ? {} : { tenantId: GUID_ERROR }),
      ...(GUID.test(subscription) ? {} : { subscriptionId: GUID_ERROR }),
    };
    setErrors(found);
    setStatus("");
    setFailure("");
    setConnected(false);
    if (found.tenantId || found.subscriptionId) {
      return;
    }
    setConnecting(true);
    try {
      const result = await source.connect({
        tenantId: tenant,
        subscriptionId: subscription,
      });
      const summary = `Connected tenant ${tenant} and subscription ${subscription}.`;
      setStatus(
        result.scanStarted
          ? `${summary} First scan started.`
          : (result.attention ?? `${summary} No scan was started.`),
      );
      setConnected(true);
    } catch (error) {
      setFailure(
        failureMessage(toDataError(error), "connect this subscription"),
      );
    } finally {
      setConnecting(false);
    }
  }

  return (
    <>
      <h1 className="page-title" id="page-title" tabIndex={-1}>
        Connect Azure
      </h1>
      <p className="page-description">
        Farside uses federated credentials. It never asks for a client secret.
      </p>
      <h2>Required read-only roles</h2>
      <ul className="tag-list" role="list">
        {REQUIRED_AZURE_ROLES.map((role) => (
          <li className="chip chip-neutral" key={role}>
            {role}
          </li>
        ))}
      </ul>
      <h2>Connect steps</h2>
      <ol className="panel step-list">
        {CONNECT_STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <form className="panel form" onSubmit={onSubmit} noValidate>
        <div className="field">
          <label htmlFor={tenantFieldId}>Azure tenant id</label>
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
          <label htmlFor={subscriptionFieldId}>Azure subscription id</label>
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
          <button
            className="action action-primary"
            type="submit"
            disabled={connecting}
          >
            {connecting ? "Connecting..." : "Connect subscription"}
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
      {failure ? (
        <p className="notice notice-alert" role="alert">
          {failure}
        </p>
      ) : null}
    </>
  );
}
