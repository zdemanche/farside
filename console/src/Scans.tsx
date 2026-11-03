import { useEffect, useRef, useState } from "react";
import { Chip, coverageTone, type Tone } from "./Chip";
import { useScans, useSource } from "./data/context";
import type { ScanCoverageSummary, ScanRow, ScanStatus } from "./data/types";
import { useResource } from "./data/use-resource";
import { Time } from "./format";
import { scanHref } from "./links";
import { ScreenState } from "./ScreenState";
import { plural } from "./plural";
import { NO_CLOUD_ERROR, TERMS, coverageStateLabel, scanErrorText } from "./terms";

const STATUS_TONE: Record<ScanStatus, Tone> = {
  queued: "neutral",
  running: "warn",
  succeeded: "good",
  failed: "crit",
};

type Tracked = { rows: ScanRow[] | undefined; inFlight: ScanRow[] };

const MAX_POLLS = 100;
const MAX_DELAY_MS = 60_000;

const isInFlight = (scan: ScanRow) => scan.status === "queued" || scan.status === "running";

function selectedId(hash: string): string {
  const match = hash.match(/^scans\/(.+)$/)?.[1] ?? "";
  try {
    return decodeURIComponent(match);
  } catch {
    return match;
  }
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
  return `${summary.assessed} ${TERMS.assessed}, ${summary.unassessed} ${TERMS.notAssessed}, ${summary.undetermined} ${TERMS.undetermined}`;
}

function ScanError({ scan }: { scan: ScanRow }) {
  return scan.error ? (
    <>
      {scanErrorText(scan.error)}
      {scan.error === NO_CLOUD_ERROR ? (
        <>
          {" "}
          <a href="#connect">Connect a cloud</a>
        </>
      ) : null}
      {scan.errorId ? ` (Reference ${scan.errorId})` : ""}
    </>
  ) : null;
}

function outcomeText(scan: ScanRow): string {
  return scan.status === "failed"
    ? `${scan.id} failed${scan.error ? `: ${scanErrorText(scan.error)}` : ""}`
    : `${scan.id} ${scan.status}`;
}

function ScanDetail({ id }: { id: string }) {
  const source = useSource();
  const resource = useResource((signal) => source.scan(id, signal), [source, id]);
  useEffect(() => {
    if (resource.status === "ready" || resource.status === "error") {
      document.getElementById("scan-detail-title")?.focus();
    }
  }, [resource.status, id]);
  return (
    <ScreenState
      label={`scan ${id}`}
      resource={resource}
      missing={
        <>
          <h2 id="scan-detail-title" tabIndex={-1}>
            Scan {id} was not found
          </h2>
          <p>
            <a href="#scans">Back to all scans</a>
          </p>
        </>
      }
    >
      {(scan) => (
        <article className="panel detail" aria-labelledby="scan-detail-title">
          <h2 id="scan-detail-title" tabIndex={-1}>
            {scan.id}
          </h2>
          <p>
            Start <Time value={scan.startedAt} fallback="Not started" />
          </p>
          <p>Duration {formatDuration(scan.durationMs)}</p>
          <p>
            Status {scan.status}
            {scan.current ? " current" : ""}
          </p>
          <p>Coverage {formatCoverage(scan.coverageSummary)}</p>
          {scan.error ? (
            <p>
              Failed <ScanError scan={scan} />
            </p>
          ) : null}
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
                      <Chip tone={coverageTone(check.state)}>
                        {coverageStateLabel(check.state)}
                      </Chip>
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
  const scans = useScans();
  const { refresh } = scans;
  const rows = scans.status === "ready" ? scans.data : undefined;
  const inFlight = rows?.find(isInFlight);
  const detailId = selectedId(hash);

  const polls = useRef(0);
  const openedWith = useRef(scans.status);
  const [tracked, setTracked] = useState<Tracked>({ rows: undefined, inFlight: [] });
  const [finished, setFinished] = useState("");

  if (rows && rows !== tracked.rows) {
    const outcomes = tracked.inFlight.flatMap((before) => {
      const after = rows.find((scan) => scan.id === before.id);
      return after && !isInFlight(after) ? [outcomeText(after)] : [];
    });
    setTracked({ rows, inFlight: rows.filter(isInFlight) });
    if (outcomes.length > 0) {
      setFinished(outcomes.join("; "));
    }
  }

  useEffect(() => {
    if (openedWith.current === "ready") {
      refresh();
    }
  }, [refresh]);

  useEffect(() => {
    if (!inFlight) {
      polls.current = 0;
      return;
    }
    if (polls.current >= MAX_POLLS) {
      return;
    }
    const delay = Math.min(pollMs * 2 ** Math.min(polls.current, 16), MAX_DELAY_MS);
    const timer = window.setTimeout(() => {
      polls.current += 1;
      refresh();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [rows, inFlight, pollMs, refresh]);

  return (
    <>
      <h1 className="page-title" id="page-title" tabIndex={-1}>
        Scans
      </h1>
      <p className="page-description">
        Each scan, when it ran, and which scopes were assessed. A failed scan is never the current
        one.
      </p>
      <p
        className="page-meta"
        role="status"
        aria-live="polite"
        data-busy={inFlight ? "true" : undefined}
      >
        {scans.status === "loading" ? (
          `Loading scan history`
        ) : rows && rows.length > 0 ? (
          <>
            <span>{finished || (inFlight ? "" : plural(rows.length, "scan"))}</span>
            {inFlight ? (
              <span>
                {finished ? "; " : ""}
                {outcomeText(inFlight)}
              </span>
            ) : null}
          </>
        ) : null}
      </p>
      <ScreenState
        label="scan history"
        resource={scans}
        silentLoading
        empty={(data) =>
          data.length === 0
            ? "No scans have run yet. Connect a subscription to start the first scan."
            : null
        }
      >
        {(data) => (
          <>
            <div
              className="table-wrap"
              role="region"
              aria-labelledby="scans-caption"
              aria-busy={inFlight ? true : undefined}
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
                        <a href={scanHref(scan.id)}>{scan.id}</a>
                      </th>
                      <td>
                        <Time value={scan.startedAt} fallback="not started" />
                      </td>
                      <td className="num">{formatDuration(scan.durationMs)}</td>
                      <td>
                        <Chip tone={STATUS_TONE[scan.status]}>{scan.status}</Chip>
                        {scan.current ? " current" : ""}
                        {scan.error ? " " : ""}
                        <ScanError scan={scan} />
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
      {detailId ? (
        <ScanDetail
          key={`${detailId}:${rows?.find((scan) => scan.id === detailId)?.status}`}
          id={detailId}
        />
      ) : null}
    </>
  );
}
