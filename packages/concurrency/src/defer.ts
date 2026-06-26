import { currentScope } from "./scope";
import type { DeferCallback } from "./types";

/**
 * Register a cleanup to run when the current coroutine unwinds (normal completion
 * or cancellation). Defers run LIFO. Outside a coroutine this is a no-op.
 */
export function defer(fn: DeferCallback): void {
  currentScope()?.defers.push(fn);
}
