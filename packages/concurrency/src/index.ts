// @arche/concurrency - lightweight, non-viral structured concurrency for TypeScript.
// Implemented incrementally via TDD; see DESIGN.md for the full spec.

import { coroutine } from "./coroutine";
import { defer } from "./defer";
import { sleep } from "./sleep";

export const io = {
  coroutine,
  sleep,
};

export { CancelledError, ConcurrencyError, CoroutineAlreadyStartedError } from "./errors";
export type { Coroutine, CoroutineBody, Ctx, DeferCallback, RoutineHandle } from "./types";
export { defer };
