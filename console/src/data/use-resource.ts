import { useCallback, useEffect, useRef, useState } from "react";
import { toDataError, type DataError } from "./error";

export type Resource<T> = { retry: () => void; refresh: () => void } & (
  | { status: "loading"; data: undefined; error: null }
  | { status: "error"; data: undefined; error: DataError }
  | { status: "ready"; data: T; error: null }
);

type Outcome<T> = { status: "error"; error: DataError } | { status: "ready"; data: T };
type Settled<T> = { deps: readonly unknown[]; outcome: Outcome<T> | null };

const sameDeps = (left: readonly unknown[], right: readonly unknown[]) =>
  left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): Resource<T> {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled<T>>({ deps, outcome: null });
  const quietRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    if (!quietRef.current) {
      setSettled({ deps, outcome: null });
    }
    quietRef.current = false;
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) {
          setSettled({ deps, outcome: { status: "ready", data } });
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setSettled({ deps, outcome: { status: "error", error: toDataError(error) } });
        }
      },
    );
    return () => controller.abort();
  }, [...deps, attempt]);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  const refresh = useCallback(() => {
    quietRef.current = true;
    setAttempt((count) => count + 1);
  }, []);

  const outcome = sameDeps(settled.deps, deps) ? settled.outcome : null;
  if (outcome?.status === "ready") {
    return { status: "ready", data: outcome.data, error: null, retry, refresh };
  }
  if (outcome?.status === "error") {
    return { status: "error", data: undefined, error: outcome.error, retry, refresh };
  }
  return { status: "loading", data: undefined, error: null, retry, refresh };
}
