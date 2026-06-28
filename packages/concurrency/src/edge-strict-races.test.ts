import { describe, expect, test } from "bun:test";
import { defer, io } from "./index";

describe("strict structured concurrency races", () => {
  test("multiple background siblings are all torn down when the parent completes", async () => {
    const cleaned = new Set<string>();
    await io
      .coroutine(async () => {
        for (const id of ["a", "b", "c"]) {
          io.coroutine(async () => {
            defer(() => cleaned.add(id));
            await io.sleep(1000);
          }).spawn();
        }
        // Parent returns immediately; all three siblings must be reaped.
      })
      .spawn();
    expect(cleaned).toEqual(new Set(["a", "b", "c"]));
  });

  test("a background grandchild is torn down leaf-first on the parent's normal completion", async () => {
    const order: string[] = [];
    await io
      .coroutine(async () => {
        io.coroutine(async () => {
          defer(() => order.push("child cleanup"));
          io.coroutine(async () => {
            defer(() => order.push("grandchild cleanup"));
            await io.sleep(1000);
          }).spawn();
          await io.sleep(1000);
        }).spawn();
        // give the grandchild a tick to spawn before the parent returns
        await io.sleep(10);
      })
      .spawn();
    expect(order).toEqual(["grandchild cleanup", "child cleanup"]);
  });

  test("a background child that finishes before the parent is cleanly deregistered", async () => {
    const events: string[] = [];
    await io
      .coroutine(async () => {
        io.coroutine(async () => {
          events.push("child done");
        }).spawn();
        await io.sleep(20);
        events.push("parent done");
      })
      .spawn();
    expect(events).toEqual(["child done", "parent done"]);
  });
});
