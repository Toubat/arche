import { describe, expect, test } from "bun:test";
import { CancelledError, io } from "./index";

async function caught(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

describe("io.mutex", () => {
  test("serializes runExclusive sections (no overlap)", async () => {
    const m = io.mutex();
    const order: string[] = [];
    const a = m.runExclusive(async () => {
      order.push("a-start");
      await io.sleep(10);
      order.push("a-end");
    });
    const b = m.runExclusive(async () => {
      order.push("b-start");
      await io.sleep(1);
      order.push("b-end");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  test("runExclusive returns fn's value", async () => {
    const m = io.mutex();
    expect(await m.runExclusive(() => 42)).toBe(42);
  });

  test("runExclusive releases the permit even when fn throws", async () => {
    const m = io.mutex();
    const boom = new Error("boom");
    expect(
      await caught(
        m.runExclusive(() => {
          throw boom;
        }),
      ),
    ).toBe(boom);
    expect(m.available).toBe(1);
  });

  test("the release token is idempotent", async () => {
    const m = io.mutex();
    const release = await m.acquire();
    expect(m.available).toBe(0);
    release();
    release();
    expect(m.available).toBe(1);
  });

  test("waiters acquire in FIFO order", async () => {
    const m = io.mutex();
    const held = await m.acquire();
    const order: number[] = [];
    const w1 = m.acquire().then((r) => {
      order.push(1);
      return r;
    });
    const w2 = m.acquire().then((r) => {
      order.push(2);
      return r;
    });
    held(); // wakes w1
    (await w1)(); // w1 releases -> wakes w2
    await w2;
    expect(order).toEqual([1, 2]);
  });

  test("a blocked acquire is cancellable and does not steal the permit", async () => {
    const m = io.mutex();
    await m.acquire(); // lock held
    const handle = io
      .coroutine(async () => {
        const release = await m.acquire(); // parks
        release();
      })
      .spawn();
    handle.cancel();
    expect(await caught(handle)).toBeInstanceOf(CancelledError);
    expect(m.available).toBe(0);
  });
});

describe("io.semaphore", () => {
  test("allows up to n holders concurrently and blocks the next", async () => {
    const s = io.semaphore(2);
    const r1 = await s.acquire();
    const r2 = await s.acquire();
    expect(s.available).toBe(0);

    let third = false;
    const pending = s.acquire().then((r) => {
      third = true;
      return r;
    });
    await Promise.resolve();
    expect(third).toBe(false);

    r1(); // hands the permit to the parked third acquirer
    const r3 = await pending;
    expect(third).toBe(true);

    r2();
    r3();
    expect(s.available).toBe(2);
  });
});

describe("io.semaphore strict cancellation", () => {
  // A blocking op in an aborted scope must make no progress, even when a permit
  // is free and acquire could complete synchronously -- like the coroutine spawn
  // short-circuit and the channel strict semantics.
  test("strict: a cancelled coroutine cannot acquire a free permit", async () => {
    const s = io.semaphore(1); // one permit sitting free

    let acquiredWhileCancelled = false;
    const doomed = io
      .coroutine(async () => {
        try {
          await io.sleep(1000); // cancellation is injected here
        } catch {
          // Swallow it, then misbehave: try to grab the free permit post-cancel.
        }
        await s.acquire(); // strict: must reject with CancelledError
        acquiredWhileCancelled = true; // strict: unreachable
      })
      .spawn();

    await io.sleep(5); // let `doomed` park at sleep(1000)
    doomed.cancel();
    expect(await caught(doomed)).toBeInstanceOf(CancelledError);

    // Strict: the cancelled coroutine took no permit, so it is still available.
    expect(acquiredWhileCancelled).toBe(false);
    expect(s.available).toBe(1);
  });
});
