import { useCallback, useEffect, useRef, useState } from "react";
import { toDataError, type DataError } from "./error";

export type Resource<T> = { retry: () => void; refresh: () => void } & (
  | { status: "loading"; data: undefined; error: null }
  | { status: "error"; data: undefined; error: DataError }
  | { status: "ready"; data: T; error: null }
);

type Settled<T> =
  | { status: "loading" }
  | { status: "error"; error: DataError }
  | { status: "ready"; data: T };

export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): Resource<T> {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled<T>>({ status: "loading" });
  const loadRef = useRef(load);
  loadRef.current = load;
  const quietRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    if (!quietRef.current) {
      setSettled({ status: "loading" });
    }
    quietRef.current = false;
    loadRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) {
          setSettled({ status: "ready", data });
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setSettled({ status: "error", error: toDataError(error) });
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

  if (settled.status === "ready") {
    return { status: "ready", data: settled.data, error: null, retry, refresh };
  }
  if (settled.status === "error") {
    return { status: "error", data: undefined, error: settled.error, retry, refresh };
  }
  return { status: "loading", data: undefined, error: null, retry, refresh };
}
