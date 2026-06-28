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

describe("error propagation", () => {
  test("a non-cancel error still runs defers and rejects with that error", async () => {
    const boom = new Error("body failed");
    const order: string[] = [];
    const handle = io
      .coroutine(async () => {
        defer(() => order.push("cleanup"));
        await io.sleep(1);
        throw boom;
      })
      .spawn();
    const err = await caught(handle);
    expect(err).toBe(boom);
    expect(err).not.toBeInstanceOf(CancelledError);
    expect(order).toEqual(["cleanup"]);
    expect(handle.cancelled).toBe(false);
  });

  test("a synchronous throw before any await still runs defers and rejects", async () => {
    const boom = new Error("sync failure");
    const order: string[] = [];
    const handle = io
      .coroutine(async () => {
        defer(() => order.push("cleanup"));
        throw boom;
      })
      .spawn();
    expect(await caught(handle)).toBe(boom);
    expect(order).toEqual(["cleanup"]);
  });
});
