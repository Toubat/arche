import { describe, expect, test } from "bun:test";
import { io } from "./index";

describe("lifecycle / memoization", () => {
  test("awaiting a handle twice yields the same memoized result and runs the body once", async () => {
    let runs = 0;
    const handle = io
      .coroutine(async () => {
        runs++;
        await io.sleep(1);
        return { value: 42 };
      })
      .spawn();
    const a = await handle;
    const b = await handle;
    expect(a).toEqual({ value: 42 });
    expect(b).toBe(a);
    expect(runs).toBe(1);
  });

  test("awaiting after the coroutine already settled resolves immediately", async () => {
    const handle = io.coroutine(async () => "early").spawn();
    const first = await handle;
    expect(first).toBe("early");
    // Already settled; awaiting again is immediate and identical.
    expect(await handle).toBe("early");
  });

  test("a void-returning coroutine resolves to undefined", async () => {
    const result = await io
      .coroutine(async () => {
        await io.sleep(1);
      })
      .spawn();
    expect(result).toBeUndefined();
  });

  test("a late cancel() after the coroutine already resolved preserves the result", async () => {
    const handle = io
      .coroutine(async () => {
        await io.sleep(1);
        return "ok";
      })
      .spawn();
    expect(await handle).toBe("ok");
    // The body has already resolved; cancelling now must not rewrite the result.
    handle.cancel();
    expect(await handle).toBe("ok");
  });
});
