import { useId, useState, type FormEvent } from "react";
import { useSource } from "./data/context";
import { failureMessage, toDataError } from "./data/error";
import type { OrgSettings } from "./data/types";
import { useResource } from "./data/use-resource";
import { ScreenState } from "./ScreenState";

export const THEME_STORAGE_KEY = "reflow-theme";

const THEMES = [
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

function SettingsForm({ initial }: { initial: OrgSettings }) {
  const source = useSource();
  const ownerId = useId();
  const prodKeyId = useId();
  const prodValueId = useId();
  const retentionId = useId();
  const scheduleId = useId();
  const intervalId = useId();
  const retryId = useId();
  const [owner, setOwner] = useState(initial.ownerTagKey);
  const [prodKey, setProdKey] = useState(initial.productionTagKey);
  const [prodValue, setProdValue] = useState(initial.productionTagValue);
  const [retention, setRetention] = useState(String(initial.snapshotRetentionDays));
  const [scheduleOn, setScheduleOn] = useState(initial.scanScheduleEnabled);
  const [interval, setInterval] = useState(String(initial.scanIntervalHours));
  const [retryLimit, setRetryLimit] = useState(String(initial.scanRetryLimit));
  const [status, setStatus] = useState("");
  const [failure, setFailure] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next: OrgSettings = {
      ...initial,
      ownerTagKey: owner,
      productionTagKey: prodKey,
      productionTagValue: prodValue,
      snapshotRetentionDays: Number(retention),
      scanScheduleEnabled: scheduleOn,
      scanIntervalHours: Number(interval),
      scanRetryLimit: Number(retryLimit),
    };
    setSaving(true);
    setFailure("");
    setStatus("");
    try {
      const saved = await source.saveSettings(next);
      const demoPrefix = source.mode === "demo" ? "Saved for this demo session only. " : "";
      setStatus(
        `${demoPrefix}Saved owner tag ${saved.ownerTagKey}, production marker ${saved.productionTagKey}=${saved.productionTagValue}, and snapshot retention ${saved.snapshotRetentionDays} days. The next scan will use these conventions. Next run follows the ${saved.scanIntervalHours}-hour schedule.`,
      );
    } catch (error) {
      setFailure(failureMessage(toDataError(error), "save settings"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
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
          <button className="action action-primary" type="submit" disabled={saving}>
            Save settings
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

function Appearance() {
  const themeName = useId();
  const [theme, setTheme] = useState<Theme>(currentTheme);

  function chooseTheme(next: Theme) {
    setTheme(next);
    applyTheme(next);
  }

  return (
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
  );
}

export function Settings() {
  const source = useSource();
  const settings = useResource((signal) => source.settings(signal), [source]);
  return (
    <>
      <h1 className="page-title" id="page-title" tabIndex={-1}>
        Settings
      </h1>
      <ScreenState label="settings" resource={settings}>
        {(data) => <SettingsForm initial={data} />}
      </ScreenState>
      <Appearance />
    </>
  );
}
