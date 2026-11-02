import { useId, useState, type FormEvent } from "react";

export function Settings({
  ownerTagKey = "owner",
  productionTagKey = "environment",
  productionTagValue = "prod",
  snapshotRetentionDays = 30,
  onSave,
}: {
  ownerTagKey?: string;
  productionTagKey?: string;
  productionTagValue?: string;
  snapshotRetentionDays?: number;
  onSave?: (next: {
    ownerTagKey: string;
    productionTagKey: string;
    productionTagValue: string;
    snapshotRetentionDays: number;
  }) => void;
}) {
  const ownerId = useId();
  const prodKeyId = useId();
  const prodValueId = useId();
  const retentionId = useId();
  const [owner, setOwner] = useState(ownerTagKey);
  const [prodKey, setProdKey] = useState(productionTagKey);
  const [prodValue, setProdValue] = useState(productionTagValue);
  const [retention, setRetention] = useState(String(snapshotRetentionDays));
  const [status, setStatus] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const snapshotRetentionDays = Number(retention);
    onSave?.({
      ownerTagKey: owner,
      productionTagKey: prodKey,
      productionTagValue: prodValue,
      snapshotRetentionDays,
    });
    setStatus(
      `Saved owner tag ${owner}, production marker ${prodKey}=${prodValue}, and snapshot retention ${snapshotRetentionDays} days. The next scan will use these conventions.`,
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
        <div>
          <label htmlFor={retentionId}>Snapshot retention days</label>
          <input
            id={retentionId}
            name="snapshotRetentionDays"
            type="number"
            min={1}
            value={retention}
            onChange={(event) => setRetention(event.target.value)}
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
