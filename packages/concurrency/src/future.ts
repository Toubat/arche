import { CancelledError } from "./errors";
import { currentScope } from "./scope";
import type { Future } from "./types";

class FutureImpl<T> implements Future<T> {
  #settled = false;
  #resolve!: (value: T) => void;
  #reject!: (error: unknown) => void;
  readonly #promise: Promise<T>;

  constructor() {
    this.#promise = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    // Suppress unhandled-rejection noise if the future is rejected (including by
    // cancellation) but never awaited; real consumers still see it via `then`.
    void this.#promise.catch(() => {});

    const signal = currentScope()?.signal;
    if (signal) this.#bindCancellation(signal);
  }

  get settled(): boolean {
    return this.#settled;
  }

  resolve(value: T): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolve(value);
  }

  reject(error: unknown): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#reject(error);
  }

  // biome-ignore lint/suspicious/noThenProperty: a Future is intentionally thenable (PromiseLike) so it can be awaited.
  then<R1 = T, R2 = never>(
    onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.#promise.then(onFulfilled, onRejected);
  }

  // Cancellation is intrinsic and bound to the creating coroutine: when that scope
  // is cancelled the future rejects itself (write-once, so a later resolve is a
  // no-op). No per-await wrapper, and the internal promise is never left dangling.
  #bindCancellation(signal: AbortSignal): void {
    if (signal.aborted) {
      this.reject(new CancelledError());
      return;
    }
    const onAbort = () => this.reject(new CancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    // Drop the listener once settled by any means (resolve/reject/abort).
    void this.#promise.finally(() => signal.removeEventListener("abort", onAbort)).catch(() => {});
  }
}

/** Create a {@link Future}: an externally resolved/rejected, cancellable awaitable. */
export function future<T>(): Future<T> {
  return new FutureImpl<T>();
}
