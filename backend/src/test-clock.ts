import type { Clock } from "./clock.js";

export const FIXED_NOW = "1970-01-01T00:00:00.000Z";

export const fixedClock: Clock = () => FIXED_NOW;

export const TEST_APP_OPTIONS = { clock: fixedClock, trustClientClock: true } as const;

export function tickingClock(startMs = 0, stepMs = 1): Clock {
  let next = startMs;
  return () => {
    const iso = new Date(next).toISOString();
    next += stepMs;
    return iso;
  };
}
