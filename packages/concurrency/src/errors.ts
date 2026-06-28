export type ConcurrencyErrorCode =
  | "cancelled"
  | "already_started"
  | "no_active_coroutine"
  | "timeout"
  | "channel_closed"
  | "waitgroup";

export class ConcurrencyError extends Error {
  readonly code: ConcurrencyErrorCode;

  constructor(message: string, code: ConcurrencyErrorCode) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class CancelledError extends ConcurrencyError {
  constructor(message = "coroutine cancelled") {
    super(message, "cancelled");
  }
}

export class CoroutineAlreadyStartedError extends ConcurrencyError {
  constructor(message = "coroutine already started") {
    super(message, "already_started");
  }
}

export class TimeoutError extends ConcurrencyError {
  constructor(message = "operation timed out") {
    super(message, "timeout");
  }
}

export class ChannelClosedError extends ConcurrencyError {
  constructor(message = "channel is closed") {
    super(message, "channel_closed");
  }
}

export class WaitGroupError extends ConcurrencyError {
  constructor(message = "wait group counter went negative") {
    super(message, "waitgroup");
  }
}
