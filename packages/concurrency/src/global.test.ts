import { describe, expect, test } from "bun:test";
import { CancelledError, defer, io } from "./index";

async function caught(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

describe("io.cancelGlobal", () => {
  test("cancels all top-level coroutines", async () => {
    const a = io
      .coroutine(async () => {
        await io.sleep(1000);
      })
      .spawn();
    const b = io
      .coroutine(async () => {
        await io.sleep(1000);
      })
      .spawn();

    io.cancelGlobal();

    expect(await caught(a)).toBeInstanceOf(CancelledError);
    expect(await caught(b)).toBeInstanceOf(CancelledError);
  });

  test("installs a fresh root so coroutines spawned afterwards are unaffected", async () => {
    const before = io
      .coroutine(async () => {
        await io.sleep(1000);
      })
      .spawn();
    io.cancelGlobal();
    expect(await caught(before)).toBeInstanceOf(CancelledError);

    // A coroutine spawned after the reset must run normally.
    const after = io.coroutine(async () => "ok").spawn();
    expect(await after).toBe("ok");
  });
});

describe("io.cancelGlobalGracefully", () => {
  test("cancels top-level coroutines and awaits their defers before resolving", async () => {
    const cleaned: string[] = [];
    io.coroutine(async () => {
      defer(() => {
        cleaned.push("a");
      });
      await io.sleep(1000);
    }).spawn();
    io.coroutine(async () => {
      defer(() => {
        cleaned.push("b");
      });
      await io.sleep(1000);
    }).spawn();

    await io.cancelGlobalGracefully();

    // Graceful: every coroutine's defer ran and was awaited before we returned.
    expect([...cleaned].sort()).toEqual(["a", "b"]);
  });
});
