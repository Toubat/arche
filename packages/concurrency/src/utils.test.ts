import { describe, expect, test } from "bun:test";
import { io } from "./index";

describe("io.sleep", () => {
  test("resolves after the delay; body continues past the await", async () => {
    const events: string[] = [];
    const handle = io
      .coroutine(async () => {
        events.push("before");
        await io.sleep(10);
        events.push("after");
      })
      .spawn();
    expect(events).toEqual(["before"]);
    await handle;
    expect(events).toEqual(["before", "after"]);
  });

  test("waits at least the requested duration", async () => {
    const start = Date.now();
    await io.coroutine(async () => io.sleep(25)).spawn();
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
  });
});
