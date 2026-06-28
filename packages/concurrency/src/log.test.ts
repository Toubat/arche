import { describe, expect, test } from "bun:test";
import { consoleLogger, type Logger, log, resetLogger, setLogger } from "./index";

describe("log", () => {
  test("consoleLogger emits structured JSON to the matching console method per level", () => {
    const calls: { method: string; line: string }[] = [];
    const real = {
      debug: console.debug,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
    console.debug = (line: unknown) => calls.push({ method: "debug", line: String(line) });
    console.info = (line: unknown) => calls.push({ method: "info", line: String(line) });
    console.warn = (line: unknown) => calls.push({ method: "warn", line: String(line) });
    console.error = (line: unknown) => calls.push({ method: "error", line: String(line) });
    try {
      consoleLogger.debug("d", { a: 1 });
      consoleLogger.info("i");
      consoleLogger.warn("w", { code: "x" });
      consoleLogger.error("e", { err: "boom" });
    } finally {
      Object.assign(console, real);
    }

    expect(calls.map((c) => c.method)).toEqual(["debug", "info", "warn", "error"]);
    expect(JSON.parse(calls[0].line)).toEqual({ level: "debug", message: "d", a: 1 });
    expect(JSON.parse(calls[1].line)).toEqual({ level: "info", message: "i" });
    expect(JSON.parse(calls[2].line)).toEqual({ level: "warn", message: "w", code: "x" });
    expect(JSON.parse(calls[3].line)).toEqual({ level: "error", message: "e", err: "boom" });
  });

  test("setLogger swaps the active logger; resetLogger restores the default", () => {
    const seen: string[] = [];
    const testLogger: Logger = {
      debug: (m) => seen.push(`debug:${m}`),
      info: (m) => seen.push(`info:${m}`),
      warn: (m) => seen.push(`warn:${m}`),
      error: (m) => seen.push(`error:${m}`),
    };

    setLogger(testLogger);
    try {
      log.debug("a");
      log.info("b");
      log.warn("c");
      log.error("d");
    } finally {
      resetLogger();
    }

    expect(seen).toEqual(["debug:a", "info:b", "warn:c", "error:d"]);
  });
});
