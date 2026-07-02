import { rejectIfCancelled } from "./scope";
import type { Mutex, Semaphore } from "./types";
import { WaiterQueue } from "./waiters";

class SemaphoreImpl implements Semaphore {
  #permits: number;
  readonly #waiters = new WaiterQueue();

  constructor(permits: number) {
    this.#permits = permits;
  }

  get available(): number {
    return this.#permits;
  }

  async acquire(): Promise<() => void> {
    // Cancellation short-circuit: an aborted scope must not take a free permit.
    const cancelled = rejectIfCancelled();
    if (cancelled) return cancelled;
    if (this.#permits > 0) {
      this.#permits--;
      return this.#release();
    }
    // No permit free: park (cancellably). When woken, a permit was handed to us.
    await this.#waiters.wait(undefined);
    return this.#release();
  }

  async runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  #release(): () => void {
    let released = false;
    return () => {
      if (released) return; // idempotent
      released = true;
      // Hand the permit straight to the next waiter, or return it to the pool.
      if (!this.#waiters.wakeOne(undefined)) this.#permits++;
    };
  }
}

/** Create a counting {@link Semaphore} with `permits` available permits. */
export function semaphore(permits: number): Semaphore {
  return new SemaphoreImpl(permits);
}

/** Create a {@link Mutex} — a semaphore with a single permit. */
export function mutex(): Mutex {
  return new SemaphoreImpl(1);
}
