import { useId, useState, type FormEvent } from "react";

export function Settings({
  ownerTagKey = "owner",
  productionTagKey = "environment",
  productionTagValue = "prod",
  onSave,
}: {
  ownerTagKey?: string;
  productionTagKey?: string;
  productionTagValue?: string;
  onSave?: (next: {
    ownerTagKey: string;
    productionTagKey: string;
    productionTagValue: string;
  }) => void;
}) {
  const ownerId = useId();
  const prodKeyId = useId();
  const prodValueId = useId();
  const [owner, setOwner] = useState(ownerTagKey);
  const [prodKey, setProdKey] = useState(productionTagKey);
  const [prodValue, setProdValue] = useState(productionTagValue);
  const [status, setStatus] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave?.({ ownerTagKey: owner, productionTagKey: prodKey, productionTagValue: prodValue });
    setStatus(
      `Saved owner tag ${owner} and production marker ${prodKey}=${prodValue}. The next scan will use these conventions.`,
    );
  }

  return (
    <>
      <h1 id="page-title" tabIndex={-1}>
        Settings
      </h1>
      <form onSubmit={submit}>
        <div>
          <label htmlFor={ownerId}>Owner tag key</label>
          <input
            id={ownerId}
            name="ownerTagKey"
            value={owner}
            onChange={(event) => setOwner(event.target.value)}
            required
            aria-required="true"
          />
        </div>
        <div>
          <label htmlFor={prodKeyId}>Production tag key</label>
          <input
            id={prodKeyId}
            name="productionTagKey"
            value={prodKey}
            onChange={(event) => setProdKey(event.target.value)}
            required
            aria-required="true"
          />
        </div>
        <div>
          <label htmlFor={prodValueId}>Production tag value</label>
          <input
            id={prodValueId}
            name="productionTagValue"
            value={prodValue}
            onChange={(event) => setProdValue(event.target.value)}
            required
            aria-required="true"
          />
        </div>
        <button type="submit">Save settings</button>
      </form>
      <p role="status" aria-live="polite">
        {status}
      </p>
    </>
  );
}
