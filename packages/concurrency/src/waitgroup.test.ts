import { describe, expect, test } from "bun:test";
import { CancelledError, io, WaitGroupError } from "./index";

async function caught(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

describe("io.waitGroup", () => {
  test("wait resolves immediately when the counter is already zero", async () => {
    const wg = io.waitGroup();
    expect(wg.count).toBe(0);
    await wg.wait(); // should not hang
  });

  test("wait blocks until the counter returns to zero via done()", async () => {
    const wg = io.waitGroup();
    wg.add(2);
    let done = false;
    const waiting = wg.wait().then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    wg.done();
    await Promise.resolve();
    expect(done).toBe(false);
    wg.done();
    await waiting;
    expect(done).toBe(true);
    expect(wg.count).toBe(0);
  });

  test("add accepts an explicit delta and defaults to 1", () => {
    const wg = io.waitGroup();
    wg.add();
    wg.add(3);
    expect(wg.count).toBe(4);
  });

  test("driving the counter negative throws WaitGroupError and leaves it unchanged", () => {
    const wg = io.waitGroup();
    wg.add(1);
    expect(() => wg.add(-3)).toThrow(WaitGroupError);
    expect(wg.count).toBe(1);
  });

  test("releases all waiters when the counter hits zero", async () => {
    const wg = io.waitGroup();
    wg.add(1);
    const a = wg.wait();
    const b = wg.wait();
    wg.done();
    await Promise.all([a, b]); // both resolve
  });

  test("a blocked wait is cancellable", async () => {
    const wg = io.waitGroup();
    wg.add(1);
    const handle = io
      .coroutine(async () => {
        await wg.wait();
      })
      .spawn();
    handle.cancel();
    expect(await caught(handle)).toBeInstanceOf(CancelledError);
  });

  // A blocking op in an aborted scope must make no progress, even when the group
  // is already at zero and wait() could resolve synchronously -- like the
  // coroutine spawn short-circuit and the channel strict semantics.
  test("strict: a cancelled coroutine's wait() rejects rather than resolving on a zero counter", async () => {
    const wg = io.waitGroup(); // count 0 -> wait() would resolve immediately today

    let waitReturned = false;
    const doomed = io
      .coroutine(async () => {
        try {
          await io.sleep(1000); // cancellation is injected here
        } catch {
          // Swallow it, then misbehave: wait() on a zero-count group post-cancel.
        }
        await wg.wait(); // strict: must reject with CancelledError
        waitReturned = true; // strict: unreachable
      })
      .spawn();

    await io.sleep(5); // let `doomed` park at sleep(1000)
    doomed.cancel();
    expect(await caught(doomed)).toBeInstanceOf(CancelledError);

    // Strict: wait() short-circuited as cancelled instead of resolving on count 0.
    expect(waitReturned).toBe(false);
  });
});
