import { afterEach, describe, expect, test } from "bun:test";
import { defer, io, type Logger, resetLogger, setLogger } from "./index";

type LogEntry = { level: string; message: string; fields?: Record<string, unknown> };

function captureLogs(): LogEntry[] {
  const entries: LogEntry[] = [];
  const rec =
    (level: string): Logger["warn"] =>
    (message, fields) => {
      entries.push({ level, message, fields });
    };
  setLogger({ debug: rec("debug"), info: rec("info"), warn: rec("warn"), error: rec("error") });
  return entries;
}

afterEach(resetLogger);

describe("defer timeout", () => {
  test("the defer chain has a total budget: the cleanup signal aborts and remaining defers are skipped + warned", async () => {
    const entries = captureLogs();
    const events: string[] = [];

    await io
      .coroutine(async () => {
        // Registered first => runs LAST (LIFO); should be skipped once the budget is exhausted.
        defer(() => {
          events.push("A");
        });
        // Registered last => runs FIRST; overruns the defer budget on a cleanup sleep.
        defer(async () => {
          events.push("B-start");
          try {
            await io.sleep(1000);
          } catch {
            events.push("B-aborted");
          }
        });
        return "done";
      })
      .spawn({ deferTimeout: 30 });

    expect(events).toContain("B-start");
    expect(events).toContain("B-aborted");
    expect(events).not.toContain("A");
    expect(entries.some((e) => e.level === "warn" && e.fields?.code === "defer_timeout")).toBe(
      true,
    );
  });

  test("defers within the budget all run normally", async () => {
    const events: string[] = [];
    await io
      .coroutine(async () => {
        defer(() => {
          events.push("A");
        });
        defer(async () => {
          await io.sleep(5);
          events.push("B");
        });
        return "done";
      })
      .spawn({ deferTimeout: 1000 });

    expect(events).toEqual(["B", "A"]);
  });
});
