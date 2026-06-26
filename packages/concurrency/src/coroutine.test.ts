import { describe, expect, test } from "bun:test";
import { CoroutineAlreadyStartedError, io } from "./index";

describe("coroutine lifecycle", () => {
  test("coroutine is lazy: the body does not run until spawn()", async () => {
    let ran = false;
    const coro = io.coroutine(async () => {
      ran = true;
      return 1;
    });
    expect(ran).toBe(false);
    await coro.spawn();
    expect(ran).toBe(true);
  });

  test("await spawn() resolves to the body's return value", async () => {
    const coro = io.coroutine(async () => "hello");
    expect(await coro.spawn()).toBe("hello");
  });

  test("a second spawn() throws CoroutineAlreadyStartedError", async () => {
    const coro = io.coroutine(async () => "x");
    const handle = coro.spawn();
    expect(() => coro.spawn()).toThrow(CoroutineAlreadyStartedError);
    await handle;
  });
});
