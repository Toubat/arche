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

describe("ambient (AsyncLocalStorage) parenting", () => {
  test("a child spawned after several await hops is still parented and torn down", async () => {
    const events: string[] = [];
    const handle = io
      .coroutine(async () => {
        await io.sleep(5);
        await io.sleep(5);
        // If ALS context were lost across the await hops, this child would be a
        // detached root and would NOT be torn down when the parent is cancelled.
        io.coroutine(async () => {
          defer(() => events.push("child cleanup"));
          await io.sleep(1000);
        }).spawn();
        await io.sleep(1000);
      })
      .spawn();

    await io.sleep(40);
    handle.cancel();
    await caught(handle);
    expect(events).toEqual(["child cleanup"]);
  });

  test("a child spawned inside a Promise.all callback is still parented and torn down", async () => {
    const events: string[] = [];
    const handle = io
      .coroutine(async () => {
        await Promise.all([
          (async () => {
            await io.sleep(5);
            io.coroutine(async () => {
              defer(() => events.push("nested child cleanup"));
              await io.sleep(1000);
            }).spawn();
          })(),
        ]);
        await io.sleep(1000);
      })
      .spawn();

    await io.sleep(40);
    handle.cancel();
    await caught(handle);
    expect(events).toEqual(["nested child cleanup"]);
  });
});
