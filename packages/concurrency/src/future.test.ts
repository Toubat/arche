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

describe("io.future", () => {
  test("resolves with the externally supplied value", async () => {
    const f = io.future<string>();
    expect(f.settled).toBe(false);
    queueMicrotask(() => f.resolve("hi"));
    expect(await f).toBe("hi");
    expect(f.settled).toBe(true);
  });

  test("rejects with the externally supplied error", async () => {
    const f = io.future<string>();
    const boom = new Error("boom");
    queueMicrotask(() => f.reject(boom));
    expect(await caught(f)).toBe(boom);
  });

  test("is write-once: the first settle wins, later settles are silent no-ops", async () => {
    const f = io.future<string>();
    f.resolve("first");
    f.resolve("second");
    f.reject(new Error("ignored"));
    expect(await f).toBe("first");
  });

  test("a reject() with no awaiter does not throw or settle twice", async () => {
    const f = io.future<string>();
    f.reject(new Error("nobody awaits"));
    f.resolve("ignored");
    expect(f.settled).toBe(true);
  });

  test("awaiting a never-settled future is cancellable from within a coroutine", async () => {
    const handle = io
      .coroutine(async () => {
        const f = io.future<string>(); // never settled
        return await f;
      })
      .spawn();
    handle.cancel();
    expect(await caught(handle)).toBeInstanceOf(CancelledError);
  });

  test("cancelling unblocks the parked await via the future's rejection (body unwinds)", async () => {
    let observed: unknown;
    const handle = io
      .coroutine(async () => {
        const f = io.future<string>(); // never settled
        try {
          return await f;
        } catch (e) {
          observed = e;
          throw e;
        }
      })
      .spawn();
    handle.cancel();
    await caught(handle);
    // Let the body's catch run if it hasn't already; proves onAbort fired (no 5s reap).
    await new Promise((r) => setTimeout(r, 5));
    expect(observed).toBeInstanceOf(CancelledError);
  });

  test("awaiting a future in an already-aborted scope rejects immediately", async () => {
    const handle = io
      .coroutine(async () => {
        // Yield once so cancel() lands before we await the future; the wait then
        // short-circuits on the already-aborted signal.
        await io.sleep(0).catch(() => {});
        const f = io.future<string>();
        return await f;
      })
      .spawn();
    handle.cancel();
    expect(await caught(handle)).toBeInstanceOf(CancelledError);
  });

  test("a future resolved while awaited inside a coroutine yields its value", async () => {
    const result = await io
      .coroutine(async () => {
        const f = io.future<string>();
        queueMicrotask(() => f.resolve("inside"));
        return await f;
      })
      .spawn();
    expect(result).toBe("inside");
  });

  test("a future rejected while awaited inside a coroutine rejects the coroutine", async () => {
    const boom = new Error("inside boom");
    const handle = io
      .coroutine(async () => {
        const f = io.future<string>();
        queueMicrotask(() => f.reject(boom));
        return await f;
      })
      .spawn();
    expect(await caught(handle)).toBe(boom);
  });

  test("outside a coroutine a future is awaitable but not cancellable", async () => {
    const f = io.future<number>();
    f.resolve(42);
    expect(await f).toBe(42);
  });
});
