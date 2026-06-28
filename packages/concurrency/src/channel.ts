import { ChannelClosedError } from "./errors";
import { rejectIfCancelled } from "./scope";
import type { Channel } from "./types";
import { WaiterQueue } from "./waiters";

type Pull<T> = IteratorResult<T, undefined>;

class ChannelImpl<T> implements Channel<T> {
  readonly #capacity: number;
  readonly #buffer: T[] = [];
  readonly #receivers = new WaiterQueue<Pull<T>>();
  readonly #senders = new WaiterQueue<void, T>();
  #closed = false;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  get closed(): boolean {
    return this.#closed;
  }

  send(value: T): Promise<void> {
    // Cancellation short-circuit: an aborted scope must not deliver or buffer,
    // even when it could complete synchronously.
    const cancelled = rejectIfCancelled();
    if (cancelled) return cancelled;
    if (this.#closed) return Promise.reject(new ChannelClosedError());
    // A waiting receiver takes the value directly (covers rendezvous + backlog).
    if (this.#receivers.wakeOne({ value, done: false })) return Promise.resolve();
    // Otherwise buffer it if there is room.
    if (this.#buffer.length < this.#capacity) {
      this.#buffer.push(value);
      return Promise.resolve();
    }
    // Full: park the sender (carrying its value) until a receiver frees a slot.
    return this.#senders.wait(value);
  }

  receive(): Promise<T> {
    return this.#receive().then((result) => {
      if (result.done) throw new ChannelClosedError();
      return result.value;
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#receivers.resolveAll({ value: undefined, done: true });
    this.#senders.rejectAll(new ChannelClosedError());
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const result = await this.#receive();
      if (result.done) return;
      yield result.value;
    }
  }

  #receive(): Promise<Pull<T>> {
    // Cancellation short-circuit: an aborted scope must not drain a ready value
    // (it stays for a live receiver).
    const cancelled = rejectIfCancelled();
    if (cancelled) return cancelled;
    const ready = this.#pull();
    if (ready) return Promise.resolve(ready);
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return this.#receivers.wait(undefined);
  }

  /** Take the next ready value (from the buffer or a parked sender), or `undefined`. */
  #pull(): Pull<T> | undefined {
    if (this.#buffer.length > 0) {
      const value = this.#buffer.shift() as T;
      // A freed slot lets the oldest parked sender's value enter the buffer.
      const woken = this.#senders.wakeOne(undefined);
      if (woken) this.#buffer.push(woken.payload);
      return { value, done: false };
    }
    // Rendezvous: hand a parked sender's value straight through.
    const woken = this.#senders.wakeOne(undefined);
    if (woken) return { value: woken.payload, done: false };
    return undefined;
  }
}

/** Create a {@link Channel}. `capacity` defaults to 0 (rendezvous). */
export function channel<T>(opts?: { capacity?: number }): Channel<T> {
  return new ChannelImpl<T>(opts?.capacity ?? 0);
}
