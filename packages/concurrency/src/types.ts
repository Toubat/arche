/**
 * The read-only context of the running coroutine. Fetched on demand via
 * `io.context()` rather than threaded as a parameter, so cancellation access is
 * opt-in. Spawning children is not on `ctx` - use the ambient `io.*` helpers; the
 * scope is wired through `AsyncLocalStorage`.
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

export type CoroutineBody<T> = () => Promise<T>;

/**
 * Anything a combinator (`io.all` / `io.race` / `io.allSettled` / `io.spawn`) can
 * own and run: an inert coroutine, or a bare async body that is wrapped in
 * `io.coroutine` internally and spawned under the combinator's scope. A running
 * `RoutineHandle` is deliberately excluded - ownership stays with its spawner.
 */
export type CoroutineLike<T> = Coroutine<T> | CoroutineBody<T>;

export type DeferCallback = () => unknown | Promise<unknown>;

export interface SpawnOptions {
  /** Budget for the body to halt after cancellation before it is reaped as a zombie. Default 5000ms. */
  cancelTimeout?: number;
  /** Total budget for the LIFO defer chain. Default 5000ms. */
  deferTimeout?: number;
}

export type Backoff = "exponential" | "linear" | "constant";

export interface RetryOptions {
  /** Total attempts (not extra retries). Default 3. */
  maxAttempts?: number;
  /** Delay growth between attempts. Default "exponential". */
  backoff?: Backoff;
  /** Delay of the first backoff step, in ms. Default 100. */
  baseDelayMs?: number;
  /** Upper bound applied to every computed delay, in ms. Default 30_000. */
  maxDelayMs?: number;
  /** Full jitter: pick a random delay in `[0, computed)`. Default true. */
  jitter?: boolean;
  /** Gate a retry on the thrown error. Default: retry every non-cancellation error. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Observe each retry just before sleeping (e.g. for logging/metrics). */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/**
 * A write-once, externally-settled awaitable. `resolve`/`reject` settle it; the
 * first call wins and later calls are silent no-ops. Awaiting it inside a
 * coroutine is cancellable via the ambient scope.
 */
export interface Future<T> extends PromiseLike<T> {
  /** Settle with a value. No-op if already settled. */
  resolve(value: T): void;
  /** Settle with an error. No-op if already settled. */
  reject(error: unknown): void;
  /** Whether `resolve` or `reject` has been called. */
  readonly settled: boolean;
}

/**
 * A Go-style channel: a competing-consumer pipe between coroutines. Each value
 * is delivered to exactly one receiver. `capacity 0` is a rendezvous (every send
 * blocks until a receiver takes it); a positive capacity buffers that many values
 * before `send` blocks. All blocking ops are cancellable via the ambient scope.
 */
export interface Channel<T> extends AsyncIterable<T> {
  /** Send a value; blocks while the buffer is full. Rejects `ChannelClosedError` if closed. */
  send(value: T): Promise<void>;
  /** Receive the next value; blocks while empty. Rejects `ChannelClosedError` once closed and drained. */
  receive(): Promise<T>;
  /** Close the channel: future sends reject, blocked senders reject, and drained receivers complete. */
  close(): void;
  readonly closed: boolean;
}

/**
 * A counting semaphore guarding `n` permits. `acquire` blocks (cancellably, FIFO)
 * until a permit is free and returns an idempotent release token; `runExclusive`
 * wraps acquire/release so the permit is always returned, even on throw or cancel.
 */
export interface Semaphore {
  /** Acquire a permit, blocking until one is free. Returns an idempotent release token. */
  acquire(): Promise<() => void>;
  /** Acquire a permit, run `fn`, and always release it afterwards. */
  runExclusive<T>(fn: () => T | Promise<T>): Promise<T>;
  /** Permits currently available. */
  readonly available: number;
}

/** A mutual-exclusion lock: a {@link Semaphore} with a single permit. */
export type Mutex = Semaphore;

/**
 * A Go-style wait group: a counter you `add` to and `done` from, with `wait`
 * resolving once it returns to zero. Driving the counter below zero throws
 * `WaitGroupError`. `wait` is cancellable via the ambient scope.
 */
export interface WaitGroup {
  /** Increase the counter by `delta` (default 1). Throws `WaitGroupError` if it would go negative. */
  add(delta?: number): void;
  /** Decrement the counter by one (`add(-1)`). */
  done(): void;
  /** Resolve once the counter is zero; blocks otherwise. */
  wait(): Promise<void>;
  /** The current counter value. */
  readonly count: number;
}

/**
 * Runtime brand carried by every object minted by `io.coroutine`. Combinators use
 * it to discriminate a `CoroutineLike` nominally (branded coroutine vs bare async
 * body) instead of guessing from shape. Registered via `Symbol.for` so duplicate
 * copies of this library agree on the brand.
 */
export const COROUTINE: unique symbol = Symbol.for("@arche/concurrency.coroutine");

/** An inert, one-shot, non-thenable coroutine specification. Minted by `io.coroutine`. */
export interface Coroutine<T> {
  /** Nominal brand: only `io.coroutine` mints coroutines. */
  readonly [COROUTINE]: true;
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
