import { CancelledError } from "./errors";
import { currentScope } from "./scope";

interface Waiter<TResolve, TPayload> {
  readonly payload: TPayload;
  resolve: (value: TResolve) => void;
  reject: (error: unknown) => void;
}

/**
 * A FIFO queue of parked coroutines, the shared blocking primitive behind
 * `channel`, `mutex`, `semaphore`, and `waitGroup`.
 *
 * `wait()` parks the caller until it is woken; the wait is cancellable by the
 * ambient scope and a cancelled waiter removes itself from the queue, so a value
 * later delivered via `wakeOne()` is never handed to an abandoned waiter.
 *
 * Each waiter can carry a `payload` (e.g. a channel sender's value) that the
 * waker receives back when it wakes them.
 */
export class WaiterQueue<TResolve = void, TPayload = void> {
  readonly #queue: Waiter<TResolve, TPayload>[] = [];

  wait(payload: TPayload): Promise<TResolve> {
    const signal = currentScope()?.signal;
    if (signal?.aborted) return Promise.reject(new CancelledError());

    return new Promise<TResolve>((resolve, reject) => {
      const waiter: Waiter<TResolve, TPayload> = { payload, resolve, reject };
      this.#queue.push(waiter);
      if (!signal) return;

      const onAbort = () => {
        this.#remove(waiter);
        reject(new CancelledError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      waiter.resolve = (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      waiter.reject = (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      };
    });
  }

  /** Wake the oldest waiter with `value`; returns its payload, or `undefined` if none waiting. */
  wakeOne(value: TResolve): { payload: TPayload } | undefined {
    const waiter = this.#queue.shift();
    if (!waiter) return undefined;
    waiter.resolve(value);
    return { payload: waiter.payload };
  }

  /** Resolve every waiter with `value` (e.g. channel close waking receivers as done). */
  resolveAll(value: TResolve): void {
    for (const waiter of this.#queue.splice(0)) waiter.resolve(value);
  }

  /** Reject every waiter (e.g. channel close failing blocked senders). */
  rejectAll(error: unknown): void {
    for (const waiter of this.#queue.splice(0)) waiter.reject(error);
  }

  #remove(waiter: Waiter<TResolve, TPayload>): void {
    const index = this.#queue.indexOf(waiter);
    if (index >= 0) this.#queue.splice(index, 1);
  }
}
