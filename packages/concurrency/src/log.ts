/**
 * Minimal, swappable logging seam.
 *
 * The default sink is `console`-backed structured JSON, which is the substrate
 * Cloudflare Workers Logs indexes natively (and `console.warn`/`console.error`
 * map to the right severity). Heavyweight Node loggers (pino/winston) do not run
 * in `workerd`, so the library ships zero logging deps and lets the host swap in
 * a runtime-appropriate logger (e.g. LogTape, Sentry) via `setLogger`.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Structured fields attached to a log line; indexed by Workers Logs et al. */
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

// Exhaustive by construction: `Record<LogLevel, ...>` forces every level to map
// to a console method, and each maps to the matching severity so Workers Logs
// (and most backends) classify it correctly.
const sinks: Record<LogLevel, (line: string) => void> = {
  debug: (line) => console.debug(line),
  info: (line) => console.info(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  // One structured JSON object per line so log backends can index the fields
  // instead of text-matching a template string.
  sinks[level](JSON.stringify({ level, message, ...fields }));
}

/** The default workerd-friendly logger: structured JSON over `console.*`. */
export const consoleLogger: Logger = {
  debug: (message, fields) => emit("debug", message, fields),
  info: (message, fields) => emit("info", message, fields),
  warn: (message, fields) => emit("warn", message, fields),
  error: (message, fields) => emit("error", message, fields),
};

let current: Logger = consoleLogger;

/** Replace the active logger (e.g. wire in LogTape/Sentry, or capture in tests). */
export function setLogger(logger: Logger): void {
  current = logger;
}

/** Restore the default `console`-backed structured logger. */
export function resetLogger(): void {
  current = consoleLogger;
}

/** Library-wide logger. Delegates to the active logger so call sites never change. */
export const log: Logger = {
  debug: (message, fields) => current.debug(message, fields),
  info: (message, fields) => current.info(message, fields),
  warn: (message, fields) => current.warn(message, fields),
  error: (message, fields) => current.error(message, fields),
};
