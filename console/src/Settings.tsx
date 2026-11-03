import { useId, useState, type FormEvent } from "react";

export const THEME_STORAGE_KEY = "reflow-theme";

export const THEMES = [
  { value: "moonaan", label: "Moonaan dark" },
  { value: "daylight", label: "Daylight" },
] as const;

type Theme = (typeof THEMES)[number]["value"];

function currentTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "daylight" ? "daylight" : "moonaan";
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    return;
  }
}

export function Settings({
  ownerTagKey = "owner",
  productionTagKey = "environment",
  productionTagValue = "prod",
  snapshotRetentionDays = 30,
  scanScheduleEnabled = true,
  scanIntervalHours = 24,
  scanRetryLimit = 3,
  onSave,
}: {
  ownerTagKey?: string;
  productionTagKey?: string;
  productionTagValue?: string;
  snapshotRetentionDays?: number;
  scanScheduleEnabled?: boolean;
  scanIntervalHours?: number;
  scanRetryLimit?: number;
  onSave?: (next: {
    ownerTagKey: string;
    productionTagKey: string;
    productionTagValue: string;
    snapshotRetentionDays: number;
    scanScheduleEnabled: boolean;
    scanIntervalHours: number;
    scanRetryLimit: number;
  }) => void;
}) {
  const ownerId = useId();
  const prodKeyId = useId();
  const prodValueId = useId();
  const retentionId = useId();
  const scheduleId = useId();
  const intervalId = useId();
  const retryId = useId();
  const themeName = useId();
  const [owner, setOwner] = useState(ownerTagKey);
  const [prodKey, setProdKey] = useState(productionTagKey);
  const [prodValue, setProdValue] = useState(productionTagValue);
  const [retention, setRetention] = useState(String(snapshotRetentionDays));
  const [scheduleOn, setScheduleOn] = useState(scanScheduleEnabled);
  const [interval, setInterval] = useState(String(scanIntervalHours));
  const [retryLimit, setRetryLimit] = useState(String(scanRetryLimit));
  const [status, setStatus] = useState("");
  const [theme, setTheme] = useState<Theme>(currentTheme);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const snapshotRetentionDays = Number(retention);
    const scanIntervalHours = Number(interval);
    const scanRetryLimit = Number(retryLimit);
    onSave?.({
      ownerTagKey: owner,
      productionTagKey: prodKey,
      productionTagValue: prodValue,
      snapshotRetentionDays,
      scanScheduleEnabled: scheduleOn,
      scanIntervalHours,
      scanRetryLimit,
    });
    setStatus(
      `Saved owner tag ${owner}, production marker ${prodKey}=${prodValue}, and snapshot retention ${snapshotRetentionDays} days. The next scan will use these conventions. Next run follows the ${scanIntervalHours}-hour schedule.`,
    );
  }

  function chooseTheme(next: Theme) {
    setTheme(next);
    applyTheme(next);
  }

  return (
    <>
      <h1 className="page-title" id="page-title" tabIndex={-1}>
        Settings
      </h1>
      <form className="panel form" onSubmit={submit}>
        <div className="field">
          <label htmlFor={ownerId}>Owner tag key</label>
          <input
            className="input"
            id={ownerId}
            name="ownerTagKey"
            value={owner}
            onChange={(event) => setOwner(event.target.value)}
            required
            aria-required="true"
          />
        </div>
        <div className="field">
          <label htmlFor={prodKeyId}>Production tag key</label>
          <input
            className="input"
            id={prodKeyId}
            name="productionTagKey"
            value={prodKey}
            onChange={(event) => setProdKey(event.target.value)}
            required
            aria-required="true"
          />
        </div>
        <div className="field">
          <label htmlFor={prodValueId}>Production tag value</label>
          <input
            className="input"
            id={prodValueId}
            name="productionTagValue"
            value={prodValue}
            onChange={(event) => setProdValue(event.target.value)}
            required
            aria-required="true"
          />
        </div>
        <div className="field">
          <label htmlFor={retentionId}>Snapshot retention days</label>
          <input
            className="input"
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
        <div className="field field-check">
          <label htmlFor={scheduleId}>Scheduled scans</label>
          <input
            className="checkbox"
            id={scheduleId}
            name="scanScheduleEnabled"
            type="checkbox"
            checked={scheduleOn}
            onChange={(event) => setScheduleOn(event.target.checked)}
          />
        </div>
        <div className="field">
          <label htmlFor={intervalId}>Scan interval hours</label>
          <input
            className="input"
            id={intervalId}
            name="scanIntervalHours"
            type="number"
            min={1}
            value={interval}
            onChange={(event) => setInterval(event.target.value)}
            required
            aria-required="true"
          />
        </div>
        <div className="field">
          <label htmlFor={retryId}>Scan retry limit</label>
          <input
            className="input"
            id={retryId}
            name="scanRetryLimit"
            type="number"
            min={1}
            value={retryLimit}
            onChange={(event) => setRetryLimit(event.target.value)}
            required
            aria-required="true"
          />
        </div>
        <div>
          <button className="action action-primary" type="submit">
            Save settings
          </button>
        </div>
      </form>
      <p className="notice" role="status" aria-live="polite">
        {status}
      </p>
      <div className="panel">
        <fieldset className="fieldset">
          <legend>Appearance</legend>
          {THEMES.map((option) => (
            <label className="choice" key={option.value}>
              <input
                className="radio"
                type="radio"
                name={themeName}
                value={option.value}
                checked={theme === option.value}
                onChange={() => chooseTheme(option.value)}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      </div>
    </>
  );
}
