import { WaitGroupError } from "./errors";
import { rejectIfCancelled } from "./scope";
import type { WaitGroup } from "./types";
import { WaiterQueue } from "./waiters";

class WaitGroupImpl implements WaitGroup {
  #count = 0;
  readonly #waiters = new WaiterQueue();

  get count(): number {
    return this.#count;
  }

  add(delta = 1): void {
    const next = this.#count + delta;
    if (next < 0) throw new WaitGroupError();
    this.#count = next;
    if (this.#count === 0) this.#waiters.resolveAll(undefined);
  }

  done(): void {
    this.add(-1);
  }

  wait(): Promise<void> {
    // Cancellation short-circuit: an aborted scope must not resolve early on a
    // zero counter.
    const cancelled = rejectIfCancelled();
    if (cancelled) return cancelled;
    if (this.#count === 0) return Promise.resolve();
    return this.#waiters.wait(undefined);
  }
}

/** Create a {@link WaitGroup}. */
export function waitGroup(): WaitGroup {
  return new WaitGroupImpl();
}
