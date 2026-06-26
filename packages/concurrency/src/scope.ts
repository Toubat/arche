import { AsyncLocalStorage } from "node:async_hooks";
import type { DeferCallback } from "./types";

/** The minimal child surface a scope needs to enforce strict structured concurrency. */
export interface ChildHandle {
  cancelGracefully(): Promise<void>;
}

/**
 * The ambient state a coroutine body runs within. Propagated implicitly through
 * `AsyncLocalStorage` so framework operations (`io.sleep`, channel ops, ...) can
 * observe cancellation without being handed a signal.
 */
export interface Scope {
  readonly signal: AbortSignal;
  /** Deferred cleanups registered via `defer`, run LIFO when the scope unwinds. */
  readonly defers: DeferCallback[];
  /**
   * Coroutines spawned within this scope. Strict structured concurrency: a child's
   * lifetime cannot outlive its parent, so any still-running child is halted (and
   * awaited) when this scope exits, before this scope's own defers run.
   */
  readonly children: Set<ChildHandle>;
}

const storage = new AsyncLocalStorage<Scope>();

export function runInScope<T>(scope: Scope, fn: () => Promise<T>): Promise<T> {
  return storage.run(scope, fn);
}

export function currentScope(): Scope | undefined {
  return storage.getStore();
}
