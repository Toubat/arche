import { CancelledError, CoroutineAlreadyStartedError } from "./errors";
import { log } from "./log";
import { currentScope, makeCtx, rootScope, runInScope, type Scope } from "./scope";
import {
  COROUTINE,
  type Coroutine,
  type CoroutineBody,
  type DeferCallback,
  type RoutineHandle,
  type SpawnOptions,
} from "./types";

const DEFAULT_CANCEL_TIMEOUT_MS = 5000;
const DEFAULT_DEFER_TIMEOUT_MS = 5000;

/**
 * Run a coroutine body, then its deferred cleanups, LIFO. Cleanups run shielded
 * under a fresh, non-aborted signal so they can do bounded async work even when
 * the coroutine was cancelled.
 */
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function runWithDefers<T>(
  body: CoroutineBody<T>,
  scope: Scope,
  deferTimeout: number,
  onSettled: () => void,
): Promise<T> {
  let outcome: Outcome<T>;
  if (scope.signal.aborted) {
    // Short-circuit: the scope was already cancelled at spawn time (e.g. spawned
    // into an already-aborted parent), so never run the body at all.
    outcome = { ok: false, error: new CancelledError() };
  } else {
    try {
      outcome = { ok: true, value: await runInScope(scope, () => body()) };
    } catch (error) {
      outcome = { ok: false, error };
    }
  }

  // Cancellation wins: a coroutine whose own scope was cancelled must not report
  // success, even if the body swallowed the injected CancelledError and returned a
  // value. (A thrown error is preserved as-is for diagnostics.)
  if (outcome.ok && scope.signal.aborted) {
    outcome = { ok: false, error: new CancelledError() };
  }

  // Order matters: children BEFORE defers. Children typically use resources that
  // this scope's defers release (e.g. a child loops on a `conn` that `defer` closes),
  // so we must stop the users before releasing what they depend on — reverse-order
  // (LIFO) teardown. This also enforces strict structured concurrency: a child's
  // lifetime never outlives its parent's. Do not flip these two.
  await teardownChildren(scope);
  await runDefers(scope.defers, deferTimeout, scope.ctx.name);
  onSettled();

  if (outcome.ok) return outcome.value;
  throw outcome.error;
}

async function teardownChildren(scope: Scope): Promise<void> {
  const children = [...scope.children];
  if (children.length === 0) return;
  // cancelGracefully is idempotent and bounded by each child's own cancel timeout,
  // so a hung grandchild cannot block the parent forever.
  await Promise.all(children.map((child) => child.cancelGracefully()));
}

async function runDefers(
  defers: DeferCallback[],
  deferTimeout: number,
  name: string | undefined,
): Promise<void> {
  if (defers.length === 0) return;

  // The whole LIFO chain shares one fresh, non-aborted signal with a total budget.
  // When the budget is exhausted the signal aborts (cancelling any in-flight cleanup)
  // and the remaining defers are skipped.
  const cleanupController = new AbortController();
  const cleanupCtx = makeCtx(cleanupController.signal);
  const cleanupScope: Scope = {
    signal: cleanupController.signal,
    ctx: cleanupCtx,
    defers: [],
    children: new Set(),
  };
  const timer = setTimeout(() => cleanupController.abort(), deferTimeout);

  try {
    await runInScope(cleanupScope, async () => {
      // Drain the defer stack LIFO: newest-registered runs first.
      while (defers.length > 0) {
        if (cleanupController.signal.aborted) {
          log.warn("defer cleanup exceeded its timeout; skipping remaining defers", {
            code: "defer_timeout",
            coroutine: name ?? "coroutine",
            deferTimeoutMs: deferTimeout,
            remaining: defers.length,
          });
          return;
        }
        const fn = defers.pop();
        try {
          await fn?.();
        } catch {
          // Cleanup is best-effort; a failing defer must not abort the remaining chain.
        }
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

class RoutineHandleImpl<T> implements RoutineHandle<T> {
  readonly #bodyPromise: Promise<T>;
  readonly #controller: AbortController;
  readonly #cancelTimeout: number;
  readonly #name: string | undefined;

  /** What callers await. Follows the body, unless a hung body is reaped first. */
  readonly #external: Promise<T>;
  #resolveExternal!: (value: T) => void;
  #rejectExternal!: (error: unknown) => void;
  #settled = false;

  #cancelRequested = false;

  constructor(
    bodyPromise: Promise<T>,
    controller: AbortController,
    cancelTimeout: number,
    name: string | undefined,
  ) {
    this.#bodyPromise = bodyPromise;
    this.#controller = controller;
    this.#cancelTimeout = cancelTimeout;
    this.#name = name;
    this.#external = new Promise<T>((resolve, reject) => {
      this.#resolveExternal = resolve;
      this.#rejectExternal = reject;
    });
    // Mirror the body's outcome into the external promise (first settle wins).
    bodyPromise.then(
      (value) => this.#settle(() => this.#resolveExternal(value)),
      (error) => this.#settle(() => this.#rejectExternal(error)),
    );
  }

  #settle(apply: () => void): void {
    if (this.#settled) return;
    this.#settled = true;
    apply();
  }

  // biome-ignore lint/suspicious/noThenProperty: a RoutineHandle is intentionally thenable (PromiseLike) so it can be awaited.
  then<R1 = T, R2 = never>(
    onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.#external.then(onfulfilled, onrejected);
  }

  cancel(): void {
    this.#requestCancel(this.#cancelTimeout);
  }

  async cancelGracefully(opts?: { timeoutMs?: number }): Promise<void> {
    this.#requestCancel(opts?.timeoutMs ?? this.#cancelTimeout);
    await this.#external.catch(() => {});
  }

  #requestCancel(timeoutMs: number): void {
    if (this.#cancelRequested) return;
    this.#cancelRequested = true;
    this.#controller.abort();

    // Zombie reaper: if the body does not actually halt within the budget, settle
    // the external result as cancelled anyway and abandon the body. Callers never block forever.
    const timer = setTimeout(() => {
      this.#settle(() => {
        log.warn(
          "coroutine did not halt within its cancel timeout after cancellation; abandoning",
          {
            code: "coroutine_hung",
            coroutine: this.#name ?? "coroutine",
            cancelTimeoutMs: timeoutMs,
          },
        );
        this.#rejectExternal(new CancelledError());
      });
    }, timeoutMs);

    this.#bodyPromise.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );
  }

  get cancelled(): boolean {
    return this.#controller.signal.aborted;
  }
}

class CoroutineImpl<T> implements Coroutine<T> {
  readonly [COROUTINE] = true as const;
  readonly #body: CoroutineBody<T>;
  #started = false;

  constructor(body: CoroutineBody<T>) {
    this.#body = body;
  }

  spawn(opts?: SpawnOptions): RoutineHandle<T> {
    if (this.#started) throw new CoroutineAlreadyStartedError();

    this.#started = true;
    const controller = new AbortController();
    const { cancelTimeout = DEFAULT_CANCEL_TIMEOUT_MS, deferTimeout = DEFAULT_DEFER_TIMEOUT_MS } =
      opts ?? {};

    // Structured cancellation: aborting the parent propagates down to this child,
    // so cancellation reaches the deepest in-flight framework await. Teardown then
    // unwinds back up the await chain, running cleanups leaf-first. Top-level
    // coroutines are parented to the root scope so io.cancelGlobal() reaches them.
    const parent = currentScope() ?? rootScope();
    const onParentAbort = () => controller.abort();
    if (parent.signal.aborted) controller.abort();
    else parent.signal.addEventListener("abort", onParentAbort, { once: true });

    let handle: RoutineHandleImpl<T>;
    const onSettled = () => {
      if (!parent.signal.aborted) parent.signal.removeEventListener("abort", onParentAbort);
      parent.children.delete(handle);
    };

    const ctx = makeCtx(controller.signal);
    const scope: Scope = { signal: controller.signal, ctx, defers: [], children: new Set() };
    const promise = runWithDefers(this.#body, scope, deferTimeout, onSettled);
    handle = new RoutineHandleImpl(promise, controller, cancelTimeout, ctx.name);
    parent.children.add(handle);
    return handle;
  }
}

export function coroutine<T>(body: CoroutineBody<T>): Coroutine<T> {
  return new CoroutineImpl(body);
}
