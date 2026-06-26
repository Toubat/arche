import { describe, expect, test } from "bun:test";
import { defer, io } from "./index";

async function caught(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

describe("defer", () => {
  test("runs deferred cleanups LIFO on normal completion", async () => {
    const order: string[] = [];
    await io
      .coroutine(async () => {
        defer(() => {
          order.push("first");
        });
        defer(() => {
          order.push("second");
        });
        return "ok";
      })
      .spawn();
    expect(order).toEqual(["second", "first"]);
  });

  test("runs deferred cleanups LIFO on cancel before the handle settles", async () => {
    const order: string[] = [];
    const handle = io
      .coroutine(async () => {
        defer(() => {
          order.push("cleanup-1");
        });
        defer(() => {
          order.push("cleanup-2");
        });
        await io.sleep(200);
      })
      .spawn();
    const settled = caught(handle);
    handle.cancel();
    await settled;
    expect(order).toEqual(["cleanup-2", "cleanup-1"]);
  });

  test("awaits async defers sequentially", async () => {
    const order: string[] = [];
    await io
      .coroutine(async () => {
        defer(async () => {
          await io.sleep(20);
          order.push("slow");
        });
        defer(() => {
          order.push("fast");
        });
      })
      .spawn();
    expect(order).toEqual(["fast", "slow"]);
  });
});
