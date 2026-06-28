export type ConcurrencyErrorCode = "cancelled" | "already_started" | "no_active_coroutine";

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
