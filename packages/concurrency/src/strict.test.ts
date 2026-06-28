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

describe("strict structured concurrency: a child must not outlive its parent", () => {
  test("a bare-spawned child is torn down (its cleanup runs) when the parent completes normally", async () => {
    const events: string[] = [];
    const start = Date.now();

    await io
      .coroutine(async () => {
        // Fire-and-forget background child that would otherwise run for ~1s.
        io.coroutine(async () => {
          defer(() => {
            events.push("child cleanup");
          });
          await io.sleep(1000);
        }).spawn();

        events.push("parent done");
      })
      .spawn();

    // The parent must not settle until the child has been cancelled and cleaned up.
    expect(events).toEqual(["parent done", "child cleanup"]);
    // And it must not have waited out the child's 1s sleep.
    expect(Date.now() - start).toBeLessThan(500);
  });

  test("the parent awaits a background child's async cleanup before settling its own result", async () => {
    const events: string[] = [];

    const result = await io
      .coroutine(async () => {
        io.coroutine(async () => {
          defer(async () => {
            await io.sleep(50);
            events.push("cleanup complete");
          });
          await io.sleep(2000);
        }).spawn();

        events.push("done");
        return "result";
      })
      .spawn();

    // "done" is recorded as the body finishes; the child's async cleanup must still
    // complete before the parent settles, so it lands second.
    expect(events).toEqual(["done", "cleanup complete"]);
    expect(result).toBe("result");
  });

  test("strict teardown is bounded: a hung background child is reaped by its cancel timeout and the parent still settles", async () => {
    const entries = captureLogs();
    const start = Date.now();

    const result = await io
      .coroutine(async () => {
        // Wedged background child: never resolves, never observes its signal.
        io.coroutine(async () => {
          await new Promise<void>(() => {});
        }).spawn({ cancelTimeout: 30 });

        return "ok";
      })
      .spawn();

    expect(result).toBe("ok");
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
    expect(Date.now() - start).toBeLessThan(500);
    expect(entries.some((e) => e.level === "warn" && e.fields?.code === "coroutine_hung")).toBe(
      true,
    );
  });
});
