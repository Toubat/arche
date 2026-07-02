import { describe, expect, test } from "bun:test";
import { COROUTINE, CoroutineAlreadyStartedError, io } from "./index";

describe("coroutine lifecycle", () => {
  test("io.coroutine brands its result with the COROUTINE symbol; bare functions are unbranded", () => {
    const coro = io.coroutine(async () => 1);
    expect(COROUTINE in coro).toBe(true);
    // A bare async body (the other CoroutineLike arm) must NOT carry the brand,
    // so combinators can discriminate nominally instead of via typeof.
    const body = async () => 1;
    expect(COROUTINE in body).toBe(false);
  });

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
