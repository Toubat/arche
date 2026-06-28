import { describe, expect, test } from "bun:test";
import { io } from "./index";

describe("io.sleep edges", () => {
  test("io.sleep(0) resolves", async () => {
    let ran = false;
    await io
      .coroutine(async () => {
        await io.sleep(0);
        ran = true;
      })
      .spawn();
    expect(ran).toBe(true);
  });

  test("io.sleep works outside any coroutine (no ambient scope)", async () => {
    const start = Date.now();
    await io.sleep(15);
    expect(Date.now() - start).toBeGreaterThanOrEqual(10);
  });
});
