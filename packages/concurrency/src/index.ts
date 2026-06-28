// @arche/concurrency - lightweight, non-viral structured concurrency for TypeScript.
// Implemented incrementally via TDD; see DESIGN.md for the full spec.

import { context } from "./context";
import { coroutine } from "./coroutine";
import { defer } from "./defer";
import { sleep } from "./utils";

export const io = {
  context,
  coroutine,
  sleep,
};

export {
  CancelledError,
  ConcurrencyError,
  type ConcurrencyErrorCode,
  CoroutineAlreadyStartedError,
} from "./errors";
export {
  consoleLogger,
  type LogFields,
  type Logger,
  type LogLevel,
  log,
  resetLogger,
  setLogger,
} from "./log";
export type { Coroutine, CoroutineBody, Ctx, DeferCallback, RoutineHandle } from "./types";
export { defer };
