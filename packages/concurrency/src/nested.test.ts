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

describe("nested background routines: teardown is transitive", () => {
  test("a background grandchild is forced to exit, leaf-first, when the parent exits normally", async () => {
    const order: string[] = [];
    await io
      .coroutine(async () => {
        io.spawn(async () => {
          defer(() => order.push("child cleanup"));
          io.spawn(async () => {
            defer(() => order.push("grandchild cleanup"));
            await io.sleep(1000); // would outlive everyone if teardown were not transitive
          });
          await io.sleep(1000);
        });
        await io.sleep(5); // let the background chain park, then exit
        order.push("parent done");
      })
      .spawn();
    expect(order).toEqual(["parent done", "grandchild cleanup", "child cleanup"]);
  });

  test("cancelling the parent handle cascades through background descendants leaf-first", async () => {
    const order: string[] = [];
    const handle = io
      .coroutine(async () => {
        defer(() => order.push("parent"));
        io.spawn(async () => {
          defer(() => order.push("child"));
          io.spawn(async () => {
            defer(() => order.push("grandchild"));
            await io.sleep(1000);
          });
          await io.sleep(1000);
        });
        await io.sleep(1000);
      })
      .spawn();
    const settled = caught(handle);
    handle.cancel();
    expect(await settled).toBeInstanceOf(CancelledError);
    expect(order).toEqual(["grandchild", "child", "parent"]);
  });

  test("the parent does not settle until a background grandchild's async cleanup completes", async () => {
    const order: string[] = [];
    const result = await io
      .coroutine(async () => {
        io.spawn(async () => {
          io.spawn(async () => {
            defer(async () => {
              await io.sleep(50);
              order.push("grandchild cleanup complete");
            });
            await io.sleep(2000);
          });
          await io.sleep(2000);
        });
        await io.sleep(5);
        order.push("parent body done");
        return "result";
      })
      .spawn();
    // The awaited handle only settles after the grandchild's async defer finished.
    expect(order).toEqual(["parent body done", "grandchild cleanup complete"]);
    expect(result).toBe("result");
  });
});
