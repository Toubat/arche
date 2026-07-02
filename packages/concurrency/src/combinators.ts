import { coroutine } from "./coroutine";
import { CancelledError, TimeoutError } from "./errors";
import { log } from "./log";
import {
  type Backoff,
  COROUTINE,
  type Coroutine,
  type CoroutineLike,
  type RetryOptions,
  type RoutineHandle,
} from "./types";
import { sleep } from "./utils";

// Normalize a member to an inert coroutine: a bare async body is wrapped so it
// spawns under the caller's scope like any other member. Discriminated by the
// nominal COROUTINE brand, not by shape.
function toCoroutine<T>(like: CoroutineLike<T>): Coroutine<T> {
  return COROUTINE in like ? like : coroutine(like);
}

/**
 * Run all members concurrently and resolve with their results in input order.
 * Members may be coroutines or bare async bodies.
 *
 * Fail-fast: the first member to reject settles the handle with that error, and
 * the remaining members are torn down (their cleanups run) by the structured
 * teardown of the enclosing coroutine. Cancelling the returned handle cancels
 * every member.
 */
export function all<T>(coros: CoroutineLike<T>[]): RoutineHandle<T[]> {
  return coroutine(() => Promise.all(coros.map((c) => toCoroutine(c).spawn()))).spawn();
}

/**
 * Spawn fire-and-forget work parented to the current scope, so it is torn down
 * when that scope exits. Accepts a single coroutine or bare async body, or a
 * list of them. The returned handle may be awaited for results, but the common
 * case is to ignore it: a non-cancellation failure is surfaced to the log rather
 * than as an unhandled rejection.
 */
export function spawn<T>(coro: CoroutineLike<T>): RoutineHandle<T>;
export function spawn<T>(coros: CoroutineLike<T>[]): RoutineHandle<T[]>;
export function spawn<T>(
  arg: CoroutineLike<T> | CoroutineLike<T>[],
): RoutineHandle<T> | RoutineHandle<T[]> {
  const handle = Array.isArray(arg) ? all(arg) : toCoroutine(arg).spawn();
  void logIfUnobserved(handle);
  return handle;
}

// Surface a fire-and-forget failure to the log instead of letting it become an
// unhandled rejection. Cancellation is the normal teardown path when the parent
// scope exits, so it is not logged.
async function logIfUnobserved(handle: PromiseLike<unknown>): Promise<void> {
  try {
    await handle;
  } catch (error) {
    if (error instanceof CancelledError) return;
    log.error("unhandled error in spawned coroutine(s)", {
      code: "spawn_error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Run all members (coroutines or bare async bodies) concurrently and settle with
 * the first one to **settle** (resolve or reject), `Promise.race` semantics. The
 * losers are torn down (their cleanups run) before the handle settles. Cancelling
 * the handle cancels every member.
 */
export function race<T>(coros: CoroutineLike<T>[]): RoutineHandle<T> {
  return coroutine(() => Promise.race(coros.map((c) => toCoroutine(c).spawn()))).spawn();
}

/**
 * Run all members (coroutines or bare async bodies) concurrently and resolve with
 * a per-member settled result (`{ status: "fulfilled", value }` |
 * `{ status: "rejected", reason }`) in input order. Never rejects on a member
 * failure; all members run to completion. Cancelling the handle still cancels
 * every member.
 */
export function allSettled<T>(coros: CoroutineLike<T>[]): RoutineHandle<PromiseSettledResult<T>[]> {
  return coroutine(() => Promise.allSettled(coros.map((c) => toCoroutine(c).spawn()))).spawn();
}

/**
 * Run a coroutine with a deadline. Resolves with its value if it finishes within
 * `ms`; otherwise rejects with `TimeoutError` and tears down the work (its
 * cleanups run). The work and the timer are siblings raced against each other, so
 * whichever settles first wins and the loser is cancelled. Cancelling the handle
 * cancels both.
 */
export function withTimeout<T>(ms: number, coro: Coroutine<T>): RoutineHandle<T> {
  return coroutine(() => {
    const work = coro.spawn();
    const timer = coroutine<T>(async () => {
      await sleep(ms);
      throw new TimeoutError(`operation timed out after ${ms}ms`);
    }).spawn();
    return Promise.race([work, timer]);
  }).spawn();
}

// Exhaustive map (not a switch) so adding a Backoff variant is a compile error and
// every branch stays covered. Computes the un-jittered, un-capped delay for an attempt.
const backoffDelay: Record<Backoff, (baseDelayMs: number, attempt: number) => number> = {
  exponential: (base, attempt) => base * 2 ** (attempt - 1),
  linear: (base, attempt) => base * attempt,
  constant: (base) => base,
};

/**
 * Run `factory()` (a fresh coroutine per attempt), retrying on failure up to
 * `maxAttempts` total attempts with configurable backoff. Resolves with the first
 * successful value; rejects with the last error once attempts are exhausted or
 * `shouldRetry` returns false.
 *
 * Cancellation is terminal: a `CancelledError` is never retried, and cancelling
 * the returned handle stops the in-flight attempt and any backoff sleep.
 */
export function withRetry<T>(
  factory: () => Coroutine<T>,
  opts: RetryOptions = {},
): RoutineHandle<T> {
  const {
    maxAttempts = 3,
    backoff = "exponential",
    baseDelayMs = 100,
    maxDelayMs = 30_000,
    jitter = true,
    shouldRetry,
    onRetry,
  } = opts;
  return coroutine(async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await factory().spawn();
      } catch (error) {
        if (error instanceof CancelledError) throw error;
        const canRetry =
          attempt < maxAttempts && (shouldRetry ? shouldRetry(error, attempt) : true);
        if (!canRetry) throw error;
        const capped = Math.min(backoffDelay[backoff](baseDelayMs, attempt), maxDelayMs);
        const delay = jitter ? Math.random() * capped : capped;
        onRetry?.(error, attempt, delay);
        if (delay > 0) await sleep(delay);
      }
    }
  }).spawn();
}
