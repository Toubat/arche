import { ConcurrencyError } from "./errors";
import { currentScope } from "./scope";
import type { Ctx } from "./types";

/**
 * Read the running coroutine's context (`signal` / `cancelled` / `throwIfCancelled`).
 *
 * Access is selective: call it only when you actually need cancellation, instead
 * of every body receiving a `ctx` parameter. Inside a `defer` it returns the
 * shielded cleanup context (so `cancelled` is `false` during cleanup). Throws if
 * called outside any coroutine.
 */
export function context(): Ctx {
  const scope = currentScope();
  if (!scope) {
    throw new ConcurrencyError("io.context() called outside a coroutine", "no_active_coroutine");
  }
  return scope.ctx;
}
