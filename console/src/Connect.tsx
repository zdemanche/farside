import { useId, useState, type FormEvent } from "react";
import { CONNECT_STEPS, REQUIRED_AZURE_ROLES } from "./connect";

export function Connect() {
  const tenantFieldId = useId();
  const subscriptionFieldId = useId();
  const [tenantId, setTenantId] = useState("");
  const [subscriptionId, setSubscriptionId] = useState("");
  const [status, setStatus] = useState("");

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus(
      `Ready to connect tenant ${tenantId} and subscription ${subscriptionId}. First scan started.`,
    );
  }

  return (
    <>
      <h1 id="page-title" tabIndex={-1}>
        Connect Azure
      </h1>
      <p>Farside uses federated credentials. It never asks for a client secret.</p>
      <h2>Required read-only roles</h2>
      <ul>
        {REQUIRED_AZURE_ROLES.map((role) => (
          <li key={role}>{role}</li>
        ))}
      </ul>
      <h2>Connect steps</h2>
      <ol>
        {CONNECT_STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <form onSubmit={onSubmit}>
        <div>
          <label htmlFor={tenantFieldId}>Azure tenant id</label>
          <input
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
        <div>
          <label htmlFor={subscriptionFieldId}>Azure subscription id</label>
          <input
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
        <button type="submit">Connect subscription</button>
      </form>
      <p role="status" aria-live="polite">
        {status}
      </p>
    </>
  );
}
