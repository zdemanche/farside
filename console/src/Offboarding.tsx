import { useId, useState } from "react";
import { useSource } from "./data/context";
import { failureMessage, toDataError } from "./data/error";
import type { DeletionView } from "./data/types";
import { useResource } from "./data/use-resource";
import { ExportButton } from "./ExportButton";
import { Time } from "./format";
import { plural } from "./plural";
import { ScreenState } from "./ScreenState";

function Grants({ record }: { record: DeletionView }) {
  return (
    <section aria-labelledby="grants-title">
      <h2 id="grants-title">Access to remove from your cloud</h2>
      <p>
        Farside has deleted its copy of your data and stopped scanning. It cannot remove its own
        access from your tenant. Remove each of these yourself.
      </p>
      <ul>
        {record.grantsToRemove.map((grant) => (
          <li key={`${grant.kind}:${grant.name}`}>
            {grant.name} <span className="chip chip-neutral">{grant.kind}</span>
            {grant.optional ? " (optional)" : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Done({ record }: { record: DeletionView }) {
  const rows = Object.values(record.rowsPurged).reduce((sum, count) => sum + count, 0);
  return (
    <>
      <p role="status">
        Your data was deleted on <Time value={record.deletedAt} />. {plural(rows, "stored record")}{" "}
        removed, {plural(record.connectionsRemoved, "connection")} removed,{" "}
        {plural(record.scansStopped, "running scan")} stopped.
      </p>
      <Grants record={record} />
    </>
  );
}

function Confirm({ onDone }: { onDone: (record: DeletionView) => void }) {
  const source = useSource();
  const exportId = useId();
  const confirmId = useId();
  const [exported, setExported] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async () => {
    setBusy(true);
    setError("");
    try {
      onDone(await source.offboard());
    } catch (caught) {
      setError(failureMessage(toDataError(caught), "offboard"));
      setBusy(false);
    }
  };
  return (
    <>
      <p>
        Leaving deletes everything Farside stored for your account: inventory, findings, cost
        history and settings. This cannot be undone. Download your data first.
      </p>
      <h2>Take your data with you</h2>
      <p>These files cover all clouds, whichever cloud is selected above.</p>
      <ExportButton kind="issues" label="Export issues" allClouds />
      <ExportButton kind="inventory" label="Export inventory" allClouds />
      <ExportButton kind="cost" label="Export cost" allClouds />
      <div className="field">
        <input
          id={exportId}
          type="checkbox"
          checked={exported}
          onChange={(event) => setExported(event.target.checked)}
        />{" "}
        <label htmlFor={exportId}>I have downloaded my data or I do not need it</label>
      </div>
      <div className="field">
        <input
          id={confirmId}
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />{" "}
        <label htmlFor={confirmId}>Delete my Farside data and stop scanning</label>
      </div>
      <button
        className="action action-primary"
        type="button"
        disabled={!exported || !confirmed || busy}
        onClick={run}
      >
        {busy ? "Deleting…" : "Leave Farside"}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}

export function Offboarding() {
  const source = useSource();
  const deletion = useResource((signal) => source.deletion(signal), [source]);
  const [done, setDone] = useState<DeletionView | null>(null);
  return (
    <>
      <h1 className="page-title" id="page-title" tabIndex={-1}>
        Offboarding
      </h1>
      <ScreenState label="offboarding" resource={deletion}>
        {(existing) => {
          const record = done ?? existing;
          return record ? <Done record={record} /> : <Confirm onDone={setDone} />;
        }}
      </ScreenState>
    </>
  );
}
