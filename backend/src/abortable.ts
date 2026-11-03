const MAX_TIMER_MS = 2 ** 31 - 1;

export function abortable<T>(signal: AbortSignal, work: Promise<T>, timeoutMs: number): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error("scan aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => settle(() => reject(new Error("scan aborted")));
    const timer = setTimeout(() => {
      const error = new Error(`harvest exceeded ${timeoutMs}ms`);
      error.name = "TimeoutError";
      settle(() => reject(error));
    }, Math.min(timeoutMs, MAX_TIMER_MS));
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      finish();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}
