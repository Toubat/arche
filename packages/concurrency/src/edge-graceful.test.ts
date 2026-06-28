import { afterEach, describe, expect, test } from "bun:test";
import { CancelledError, io, type Logger, resetLogger, setLogger } from "./index";

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

async function caught(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

describe("cancelGracefully edges", () => {
  test("cancelGracefully({ timeoutMs }) reaps a hung body using the override budget", async () => {
    const entries = captureLogs();
    const handle = io
      .coroutine(async () => {
        // Ignores cancellation entirely: never settles.
        await new Promise<void>(() => {});
      })
      .spawn({ cancelTimeout: 10_000 });

    const start = Date.now();
    await handle.cancelGracefully({ timeoutMs: 30 });
    const elapsed = Date.now() - start;

    // The override (30ms), not the 10s spawn budget, governs reaping.
    expect(elapsed).toBeLessThan(1000);
    expect(await caught(handle)).toBeInstanceOf(CancelledError);
    expect(
      entries.some(
        (e) =>
          e.level === "warn" &&
          e.fields?.code === "coroutine_hung" &&
          e.fields?.cancelTimeoutMs === 30,
      ),
    ).toBe(true);
  });

  test("double cancelGracefully is idempotent and both resolve", async () => {
    const handle = io
      .coroutine(async () => {
        await io.sleep(1000);
      })
      .spawn();
    await Promise.all([handle.cancelGracefully(), handle.cancelGracefully()]);
    expect(handle.cancelled).toBe(true);
    expect(await caught(handle)).toBeInstanceOf(CancelledError);
  });

  test("cancel() followed by cancelGracefully() settles cleanly", async () => {
    let cleanedUp = false;
    const handle = io
      .coroutine(async () => {
        try {
          await io.sleep(1000);
        } finally {
          cleanedUp = true;
        }
      })
      .spawn();
    handle.cancel();
    await handle.cancelGracefully();
    expect(cleanedUp).toBe(true);
    expect(await caught(handle)).toBeInstanceOf(CancelledError);
  });
});
