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

describe("nested coroutines", () => {
  test("cancelling the parent tears down children leaf-first, before the parent's defers", async () => {
    const order: string[] = [];
    const handle = io
      .coroutine(async () => {
        defer(() => {
          order.push("Cleanup1");
        });
        await io
          .coroutine(async () => {
            defer(() => {
              order.push("Cleanup2");
            });
            await io
              .coroutine(async () => {
                defer(() => {
                  order.push("Cleanup3");
                });
                await io.sleep(1000);
              })
              .spawn();
          })
          .spawn();
      })
      .spawn();

    const settled = caught(handle);
    handle.cancel();
    expect(await settled).toBeInstanceOf(CancelledError);
    expect(order).toEqual(["Cleanup3", "Cleanup2", "Cleanup1"]);
  });

  test("a child completing normally does not cancel its siblings or parent", async () => {
    const result = await io
      .coroutine(async () => {
        const a = await io.coroutine(async () => 1).spawn();
        const b = await io.coroutine(async () => 2).spawn();
        return a + b;
      })
      .spawn();
    expect(result).toBe(3);
  });
});
