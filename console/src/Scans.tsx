import { useEffect, useState } from "react";
import { Chip, coverageTone, type Tone } from "./Chip";
import {
  SCAN_ROWS,
  completeRunningScans,
  formatCoverage,
  formatDuration,
  type ScanRow,
  type ScanStatus,
} from "./scans-data";

const STATUS_TONE: Record<ScanStatus, Tone> = {
  queued: "neutral",
  running: "warn",
  succeeded: "good",
  failed: "crit",
};

function selectedId(hash: string): string {
  const match = hash.match(/^scans\/(.+)$/);
  return match?.[1] ?? "";
}

export function Scans({
  scans = SCAN_ROWS,
  hash = typeof window === "undefined" ? "scans" : window.location.hash.replace(/^#\/?/, ""),
  progressDelayMs = 25,
}: {
  scans?: ScanRow[];
  hash?: string;
  progressDelayMs?: number;
}) {
  const [rows, setRows] = useState(scans);
  const selected = rows.find((scan) => scan.id === selectedId(hash));
  const inFlight = rows.find((scan) => scan.status === "queued" || scan.status === "running");

  useEffect(() => {
    setRows(scans);
  }, [scans]);

  useEffect(() => {
    if (!rows.some((scan) => scan.status === "queued" || scan.status === "running")) {
      return;
    }
    const timer = window.setTimeout(() => {
      setRows((current) => completeRunningScans(current));
    }, progressDelayMs);
    return () => window.clearTimeout(timer);
  }, [rows, progressDelayMs]);

  return (
    <>
      <h1 className="page-title" id="page-title" tabIndex={-1}>
        Scans
      </h1>
      <p className="page-description">
        Each scan, when it ran, and what it covered. A failed scan is never the current one.
      </p>
      <p
        className="page-meta"
        role="status"
        aria-live="polite"
        data-busy={inFlight ? "true" : undefined}
      >
        {inFlight ? (inFlight.progress ?? "Running") : `${rows.length} scans`}
      </p>
      <div className="table-wrap" tabIndex={0}>
        <table>
          <caption>Scan history</caption>
          <thead>
            <tr>
              <th scope="col">Scan</th>
              <th scope="col">Start</th>
              <th scope="col" className="num">
                Duration
              </th>
              <th scope="col">Status</th>
              <th scope="col">Coverage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((scan) => (
              <tr key={scan.id}>
                <th scope="row">
                  <a href={`#scans/${scan.id}`}>{scan.id}</a>
                </th>
                <td>{scan.startedAt ?? "not started"}</td>
                <td className="num">{formatDuration(scan.durationMs)}</td>
                <td>
                  <Chip tone={STATUS_TONE[scan.status]}>{scan.status}</Chip>
                  {scan.current ? " current" : ""}
                  {scan.error ? ` ${scan.error}` : ""}
                </td>
                <td>{formatCoverage(scan.coverageSummary)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected ? (
        <article className="panel detail" aria-labelledby="scan-detail-title">
          <h2 id="scan-detail-title">{selected.id}</h2>
          <p>Start {selected.startedAt ?? "not started"}</p>
          <p>Duration {formatDuration(selected.durationMs)}</p>
          <p>
            Status {selected.status}
            {selected.current ? " current" : ""}
          </p>
          <p>Coverage {formatCoverage(selected.coverageSummary)}</p>
          {selected.error ? <p>Failed {selected.error}</p> : null}
          <div className="table-wrap" tabIndex={0}>
            <table>
              <caption>Per-check results</caption>
              <thead>
                <tr>
                  <th scope="col">Check</th>
                  <th scope="col">State</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {selected.checks.map((check) => (
                  <tr key={check.checkId}>
                    <th scope="row">{check.checkId}</th>
                    <td>
                      <Chip tone={coverageTone(check.state)}>{check.state}</Chip>
                    </td>
                    <td>
                      {check.reason ?? ""}
                      {check.closer ? ` ${check.closer}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      ) : null}
    </>
  );
}
