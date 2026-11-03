import { useEffect } from "react";
import { Chip, coverageTone, type Tone } from "./Chip";
import { useSource } from "./data/context";
import type { ScanCoverageSummary, ScanRow, ScanStatus } from "./data/types";
import { useResource } from "./data/use-resource";
import { ScreenState } from "./ScreenState";

const STATUS_TONE: Record<ScanStatus, Tone> = {
  queued: "neutral",
  running: "warn",
  succeeded: "good",
  failed: "crit",
};

const isInFlight = (scan: ScanRow) => scan.status === "queued" || scan.status === "running";

function selectedId(hash: string): string {
  const match = hash.match(/^scans\/(.+)$/);
  return match?.[1] ?? "";
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) {
    return "in progress";
  }
  if (durationMs < 1000) {
    return `${durationMs} ms`;
  }
  return `${(durationMs / 1000).toFixed(1)} s`;
}

function formatCoverage(summary: ScanCoverageSummary): string {
  return `${summary.assessed} assessed, ${summary.unassessed} unassessed, ${summary.undetermined} undetermined`;
}

function ScanDetail({ id }: { id: string }) {
  const source = useSource();
  const resource = useResource((signal) => source.scan(id, signal), [source, id]);
  return (
    <ScreenState
      label={`scan ${id}`}
      resource={resource}
      missing="That scan does not exist."
    >
      {(scan) => (
        <article className="panel detail" aria-labelledby="scan-detail-title">
          <h2 id="scan-detail-title">{scan.id}</h2>
          <p>Start {scan.startedAt ?? "not started"}</p>
          <p>Duration {formatDuration(scan.durationMs)}</p>
          <p>
            Status {scan.status}
            {scan.current ? " current" : ""}
          </p>
          <p>Coverage {formatCoverage(scan.coverageSummary)}</p>
          {scan.error ? <p>Failed {scan.error}</p> : null}
          <div
            className="table-wrap"
            role="region"
            aria-labelledby="scan-checks-caption"
            tabIndex={0}
          >
            <table>
              <caption id="scan-checks-caption">Per-check results</caption>
              <thead>
                <tr>
                  <th scope="col">Check</th>
                  <th scope="col">State</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {scan.checks.map((check) => (
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
      )}
    </ScreenState>
  );
}

export function Scans({
  hash = typeof window === "undefined" ? "scans" : window.location.hash.replace(/^#\/?/, ""),
  pollMs = 3000,
}: {
  hash?: string;
  pollMs?: number;
}) {
  const source = useSource();
  const scans = useResource((signal) => source.scans(signal), [source]);
  const { refresh } = scans;
  const rows = scans.status === "ready" ? scans.data : undefined;
  const inFlight = rows?.find(isInFlight);
  const detailId = selectedId(hash);

  useEffect(() => {
    if (!inFlight) {
      return;
    }
    const timer = window.setTimeout(refresh, pollMs);
    return () => window.clearTimeout(timer);
  }, [rows, inFlight, pollMs, refresh]);

  return (
    <>
      <h1 className="page-title" id="page-title" tabIndex={-1}>
        Scans
      </h1>
      <p className="page-description">
        Each scan, when it ran, and what it covered. A failed scan is never the current one.
      </p>
      <ScreenState
        label="scan history"
        resource={scans}
        empty={(data) =>
          data.length === 0
            ? "No scans have run yet. Connect a subscription to start the first scan."
            : null
        }
      >
        {(data) => (
          <>
            <p
              className="page-meta"
              role="status"
              aria-live="polite"
              data-busy={inFlight ? "true" : undefined}
            >
              {inFlight ? (inFlight.status === "queued" ? "Queued" : "Running") : `${data.length} scans`}
            </p>
            <div
              className="table-wrap"
              role="region"
              aria-labelledby="scans-caption"
              tabIndex={0}
            >
              <table>
                <caption id="scans-caption">Scan history</caption>
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
                  {data.map((scan) => (
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
          </>
        )}
      </ScreenState>
      {detailId ? <ScanDetail id={detailId} /> : null}
    </>
  );
}
