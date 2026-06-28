import { AsyncLocalStorage } from "node:async_hooks";
import { CancelledError } from "./errors";
import type { Ctx, DeferCallback } from "./types";

/** The minimal child surface a scope needs to enforce strict structured concurrency. */
export interface ChildHandle {
  cancel(): void;
  cancelGracefully(opts?: { timeoutMs?: number }): Promise<void>;
}

/**
 * The ambient state a coroutine body runs within. Propagated implicitly through
 * `AsyncLocalStorage` so framework operations (`io.sleep`, channel ops, ...) can
 * observe cancellation without being handed a signal.
 */
export interface Scope {
  readonly signal: AbortSignal;
  /** The context returned by `io.context()` for code running within this scope. */
  readonly ctx: Ctx;
  /** Deferred cleanups registered via `defer`, run LIFO when the scope unwinds. */
  readonly defers: DeferCallback[];
  /**
   * Coroutines spawned within this scope. Strict structured concurrency: a child's
   * lifetime cannot outlive its parent, so any still-running child is halted (and
   * awaited) when this scope exits, before this scope's own defers run.
   */
  readonly children: Set<ChildHandle>;
}

export function makeCtx(signal: AbortSignal, name?: string): Ctx {
  return {
    signal,
    get cancelled() {
      return signal.aborted;
    },
    throwIfCancelled() {
      if (signal.aborted) throw new CancelledError();
    },
    name,
  };
}

const storage = new AsyncLocalStorage<Scope>();

export function runInScope<T>(scope: Scope, fn: () => Promise<T>): Promise<T> {
  return storage.run(scope, fn);
}

export function currentScope(): Scope | undefined {
  return storage.getStore();
}

/**
 * Shared cancellation short-circuit for blocking data-structure ops (channel,
 * semaphore, waitGroup, ...). Returns a rejected `CancelledError` promise when the
 * ambient scope is already aborted, else `undefined` so the caller proceeds. This
 * mirrors the coroutine spawn short-circuit: a blocking op in an aborted scope must
 * make no progress, even when it could complete synchronously.
 */
export function rejectIfCancelled(): Promise<never> | undefined {
  return currentScope()?.signal.aborted ? Promise.reject(new CancelledError()) : undefined;
}

// The root scope is the implicit parent of every top-level coroutine, so a single
// `io.cancelGlobal()` can tear the whole tree down. It is swappable (`resetRoot`)
// so global cancellation leaves a fresh, usable root behind.
let rootController: AbortController;
let rootScopeInstance: Scope;

function createRoot(): void {
  rootController = new AbortController();
  rootScopeInstance = {
    signal: rootController.signal,
    ctx: makeCtx(rootController.signal, "root"),
    defers: [],
    children: new Set(),
  };
}
createRoot();

export function rootScope(): Scope {
  return rootScopeInstance;
}

export function abortRoot(): void {
  rootController.abort();
}

export function resetRoot(): void {
  createRoot();
}
