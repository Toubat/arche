import { describe, expect, test } from "bun:test";
import { CancelledError, io } from "./index";

async function caught(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

describe("cancellation", () => {
  test("cancel() makes an in-flight sleep reject the body with CancelledError", async () => {
    const handle = io
      .coroutine(async () => {
        await io.sleep(200);
        return "done";
      })
      .spawn();
    handle.cancel();
    expect(handle.cancelled).toBe(true);
    expect(await caught(handle)).toBeInstanceOf(CancelledError);
  });

  test("cancel() interrupts promptly rather than waiting out the sleep", async () => {
    const start = Date.now();
    const handle = io.coroutine(async () => io.sleep(1000)).spawn();
    handle.cancel();
    await caught(handle);
    expect(Date.now() - start).toBeLessThan(100);
  });

  test("cancel() is idempotent (second cancel is a harmless no-op)", async () => {
    const handle = io.coroutine(async () => io.sleep(200)).spawn();
    const settled = caught(handle);
    handle.cancel();
    handle.cancel();
    expect(handle.cancelled).toBe(true);
    expect(await settled).toBeInstanceOf(CancelledError);
  });

  test("body runs to completion if never cancelled", async () => {
    const handle = io
      .coroutine(async () => {
        await io.sleep(5);
        return 42;
      })
      .spawn();
    expect(await handle).toBe(42);
    expect(handle.cancelled).toBe(false);
  });
});
