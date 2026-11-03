import { useId, useState, type FormEvent } from "react";
import { CONNECT_STEPS, REQUIRED_AZURE_ROLES } from "./connect-data";
import { useSource } from "./data/context";
import { ROLE_WRITE, failureMessage, toDataError } from "./data/error";

export function Connect() {
  const source = useSource();
  const tenantFieldId = useId();
  const subscriptionFieldId = useId();
  const [tenantId, setTenantId] = useState("");
  const [subscriptionId, setSubscriptionId] = useState("");
  const [status, setStatus] = useState("");
  const [failure, setFailure] = useState("");
  const [connecting, setConnecting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setConnecting(true);
    setStatus("");
    setFailure("");
    try {
      const result = await source.connect({ tenantId, subscriptionId });
      const outcome = result.scanStarted
        ? "First scan started."
        : (result.attention ?? "No scan was started.");
      setStatus(`Connected tenant ${tenantId} and subscription ${subscriptionId}. ${outcome}`);
    } catch (error) {
      setFailure(failureMessage(toDataError(error), "connect this subscription", ROLE_WRITE));
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
      <form className="panel form" onSubmit={onSubmit}>
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
          />
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
          />
        </div>
        <div>
          <button className="action action-primary" type="submit" disabled={connecting}>
            Connect subscription
          </button>
        </div>
      </form>
      <p className="notice" role="status" aria-live="polite">
        {status}
      </p>
      {failure ? (
        <p className="notice notice-alert" role="alert">
          {failure}
        </p>
      ) : null}
    </>
  );
}
