// @arche/concurrency - lightweight, non-viral structured concurrency for TypeScript.
// Implemented incrementally via TDD; see DESIGN.md for the full spec.

import { channel } from "./channel";
import { all, allSettled, race, spawn, withRetry, withTimeout } from "./combinators";
import { context } from "./context";
import { coroutine } from "./coroutine";
import { defer } from "./defer";
import { future } from "./future";
import { cancelGlobal, cancelGlobalGracefully } from "./global";
import { mutex, semaphore } from "./semaphore";
import { sleep } from "./utils";
import { waitGroup } from "./waitgroup";

export const io = {
  all,
  allSettled,
  cancelGlobal,
  cancelGlobalGracefully,
  channel,
  context,
  coroutine,
  future,
  mutex,
  race,
  semaphore,
  sleep,
  spawn,
  waitGroup,
  withRetry,
  withTimeout,
};

export {
  CancelledError,
  ChannelClosedError,
  ConcurrencyError,
  type ConcurrencyErrorCode,
  CoroutineAlreadyStartedError,
  TimeoutError,
  WaitGroupError,
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
export type {
  Backoff,
  Channel,
  Coroutine,
  CoroutineBody,
  CoroutineLike,
  Ctx,
  DeferCallback,
  Future,
  Mutex,
  RetryOptions,
  RoutineHandle,
  Semaphore,
  SpawnOptions,
  WaitGroup,
} from "./types";
export { COROUTINE } from "./types";
export { defer };
