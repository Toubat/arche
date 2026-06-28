import { afterEach, describe, expect, test } from "bun:test";
import { CancelledError, defer, io, type Logger, resetLogger, setLogger } from "./index";

async function caught(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

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

describe("cancelGracefully + cancel timeout", () => {
  test("cancelGracefully awaits teardown (async defer) completion", async () => {
    const order: string[] = [];
    const handle = io
      .coroutine(async () => {
        defer(async () => {
          await io.sleep(20);
          order.push("cleaned");
        });
        await io.sleep(1000);
      })
      .spawn();

    await handle.cancelGracefully();
    expect(order).toEqual(["cleaned"]);
    expect(handle.cancelled).toBe(true);
  });

  test("a body wedged on a raw promise is reaped after the cancel timeout, settling CancelledError + warning", async () => {
    const entries = captureLogs();
    const handle = io
      .coroutine(async () => {
        // Wedged: never resolves and never observes the signal.
        await new Promise<void>(() => {});
      })
      .spawn({ cancelTimeout: 30 });

    handle.cancel();
    const start = Date.now();
    const err = await caught(handle);
    const elapsed = Date.now() - start;

    expect(err).toBeInstanceOf(CancelledError);
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(500);
    expect(entries.some((e) => e.level === "warn" && e.fields?.code === "coroutine_hung")).toBe(
      true,
    );
  });

  test("cancelGracefully on a hung body still resolves (does not block forever)", async () => {
    captureLogs();
    const handle = io
      .coroutine(async () => {
        await new Promise<void>(() => {});
      })
      .spawn({ cancelTimeout: 30 });

    const start = Date.now();
    await handle.cancelGracefully();
    expect(Date.now() - start).toBeLessThan(500);
  });
});
