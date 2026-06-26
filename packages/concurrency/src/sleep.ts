import { CancelledError } from "./errors";
import { currentScope } from "./scope";

export function sleep(ms: number): Promise<void> {
  const signal = currentScope()?.signal;
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
