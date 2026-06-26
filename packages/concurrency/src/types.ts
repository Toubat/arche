/**
 * The read-only context handed to a coroutine body (and to a `defer` callback).
 * Spawning children is not on `ctx` - use the ambient `io.*` helpers; the scope
 * is wired through `AsyncLocalStorage`.
 */
export interface Ctx {
  /** Aborts when this unit of work is cancelled. Thread into raw async (`fetch(url, { signal })`). */
  readonly signal: AbortSignal;
  /** `=== signal.aborted`. */
  readonly cancelled: boolean;
  /** Cooperative checkpoint for tight sync loops / raw promises: throws `CancelledError` if cancelled. */
  throwIfCancelled(): void;
  /** Optional label for diagnostics (zombie / unhandled-error logs). */
  readonly name?: string;
}

export type CoroutineBody<T> = (ctx: Ctx) => Promise<T>;

export type DeferCallback = (ctx: Ctx) => void | Promise<void>;

export interface SpawnOptions {
  /** Budget for the body to halt after cancellation before it is reaped as a zombie. Default 5000ms. */
  cancelTimeout?: number;
  /** Total budget for the LIFO defer chain. Default 5000ms. */
  deferTimeout?: number;
}

/** An inert, one-shot, non-thenable coroutine specification. */
export interface Coroutine<T> {
  /** Start the coroutine exactly once. A second call throws `CoroutineAlreadyStartedError`. */
  spawn(opts?: SpawnOptions): RoutineHandle<T>;
}

/** A running coroutine instance: awaitable (thenable) and cancellable. */
export interface RoutineHandle<T> extends PromiseLike<T> {
  /** Request cancellation; fire-and-forget. Idempotent. */
  cancel(): void;
  /** Request cancellation and await teardown completion. Idempotent. */
  cancelGracefully(opts?: { timeoutMs?: number }): Promise<void>;
  readonly cancelled: boolean;
}
