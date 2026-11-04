import { useState } from "react";
import { useSource } from "./data/context";
import { failureMessage, toDataError } from "./data/error";
import type { ExportKind } from "./data/types";

function save(filename: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Downloads the farside-export/1 file for one screen. Hidden when the source cannot export. */
export function ExportButton({ kind, label }: { kind: ExportKind; label: string }) {
  const source = useSource();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  if (!source.exportFile) {
    return null;
  }
  const exportFile = source.exportFile.bind(source);
  const run = async () => {
    setBusy(true);
    setMessage("");
    try {
      const file = await exportFile(kind);
      save(file.filename, file.content);
      setMessage(`Downloaded ${file.filename}`);
    } catch (error) {
      setMessage(failureMessage(toDataError(error), `export ${kind}`));
    } finally {
      setBusy(false);
    }
  };
  return (
    <p className="export">
      <button className="action action-secondary" type="button" disabled={busy} onClick={run}>
        {busy ? "Preparing export…" : label}
      </button>{" "}
      <span role="status" aria-live="polite">
        {message}
      </span>
    </p>
  );
}
