import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { CancelledError, defer, io, type Logger, resetLogger, setLogger } from "./index";

async function caught(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

type LogEntry = { level: string; message: string; fields?: Record<string, unknown> };

function captureLogs(): LogEntry[] {
  const entries: LogEntry[] = [];
  const rec =
    (level: string): Logger["warn"] =>
    (message, fields) => {
      entries.push({ level, message, fields });
    };
  setLogger({ debug: rec("debug"), info: rec("info"), warn: rec("warn"), error: rec("error") });
  return entries;
}

// Fake-timer helpers. Bun's clock mock only has the sync advance API, so async
// timer chains need explicit microtask flushes around each advance. setImmediate
// is NOT faked by useFakeTimers, so awaiting it yields one real macrotask turn,
// draining every pending microtask (letting continuations register their timers).
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function advance(ms: number): Promise<void> {
  await flush(); // let pending continuations register their timers first
  jest.advanceTimersByTime(ms);
  await flush(); // let the fired callbacks' continuations run
}

/** Non-blocking settle probe: a settled promise's microtasks win the race against the flush macrotask. */
function stateOf(p: PromiseLike<unknown>): Promise<"settled" | "pending"> {
  return Promise.race([
    Promise.resolve(p).then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    flush().then(() => "pending" as const),
  ]);
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  resetLogger();
});

describe("cancelGracefully + cancel timeout", () => {
  test("cancelGracefully awaits teardown (async defer) completion", async () => {
    const order: string[] = [];
    const handle = io
      .coroutine(async () => {
        defer(async () => {
          await io.sleep(20);
          order.push("cleaned");
        });
        await io.sleep(1000);
      })
      .spawn();

    const done = handle.cancelGracefully();
    await advance(20); // only the defer's sleep must actually elapse
    await done;
    expect(order).toEqual(["cleaned"]);
    expect(handle.cancelled).toBe(true);
  });

  test("a body wedged on a raw promise is reaped exactly at the default cancel timeout, settling CancelledError + warning", async () => {
    const entries = captureLogs();
    const handle = io
      .coroutine(async () => {
        // Wedged: never resolves and never observes the signal.
        await new Promise<void>(() => {});
      })
      .spawn(); // default 5000ms cancelTimeout - affordable under fake time

    handle.cancel();
    const outcome = caught(handle);
    await advance(4_999); // one tick short of the budget: the caller is still blocked
    expect(await stateOf(outcome)).toBe("pending");
    await advance(1); // budget exhausted: the reaper settles the caller
    expect(await outcome).toBeInstanceOf(CancelledError);
    expect(
      entries.some(
        (e) =>
          e.level === "warn" &&
          e.fields?.code === "coroutine_hung" &&
          e.fields?.cancelTimeoutMs === 5000,
      ),
    ).toBe(true);
  });

  test("cancelGracefully on a hung body still resolves once the reap budget elapses", async () => {
    captureLogs();
    const handle = io
      .coroutine(async () => {
        await new Promise<void>(() => {});
      })
      .spawn();

    let resolved = false;
    const done = handle.cancelGracefully().then(() => {
      resolved = true;
    });
    await advance(5_000); // default budget
    await done;
    expect(resolved).toBe(true);
  });
});

describe("zombie reaping across the tree: a frozen body never blocks shutdown", () => {
  test("killing a parent with a frozen background child: sibling cleanup and parent defers still run, exit is bounded", async () => {
    const entries = captureLogs();
    const order: string[] = [];
    const handle = io
      .coroutine(async () => {
        defer(() => order.push("parent defer"));
        // Frozen child with a SHORTER reap budget than the parent's: teardown is
        // bounded by the child's budget, so the parent settles properly, not reaped.
        io.coroutine(async () => {
          await new Promise<void>(() => {});
        }).spawn({ cancelTimeout: 30 });
        // Responsive sibling: must still get its cleanup despite the zombie.
        io.coroutine(async () => {
          defer(() => order.push("sibling defer"));
          await io.sleep(10_000);
        }).spawn();
        await io.sleep(10_000);
      })
      .spawn();

    handle.cancel();
    const outcome = caught(handle);
    await advance(30); // only the frozen child's reap budget must elapse
    expect(await outcome).toBeInstanceOf(CancelledError);
    expect(order).toEqual(["sibling defer", "parent defer"]);
    expect(entries.some((e) => e.level === "warn" && e.fields?.code === "coroutine_hung")).toBe(
      true,
    );
  });

  test("a frozen grandchild cannot block the top-level parent: exit is bounded by the grandchild's cancel timeout", async () => {
    const entries = captureLogs();
    const handle = io
      .coroutine(async () => {
        io.spawn(async () => {
          io.coroutine(async () => {
            await new Promise<void>(() => {});
          }).spawn({ cancelTimeout: 30 });
          await io.sleep(10_000);
        });
        await io.sleep(5); // let the background chain park, then exit normally
        return "ok";
      })
      .spawn();

    await advance(5); // parent body finishes; teardown reaches the frozen grandchild
    await advance(30); // grandchild reap budget
    expect(await handle).toBe("ok");
    expect(entries.some((e) => e.level === "warn" && e.fields?.code === "coroutine_hung")).toBe(
      true,
    );
  });

  test("without cancellation, a body parked on a frozen raw promise stays pending (no implicit deadline)", async () => {
    captureLogs(); // silence the coroutine_hung warn from the cleanup cancel below
    const handle = io
      .coroutine(async () => {
        await new Promise<void>(() => {});
      })
      .spawn();

    await advance(60 * 60 * 1000); // a full (fake) hour: nothing in the framework times out on its own
    expect(await stateOf(handle)).toBe("pending");

    handle.cancel(); // clean up: reaped at the default budget
    await advance(5_000);
    await caught(handle);
  });

  test("cancellation cannot interrupt a raw frozen await: the body stays parked and its defers never run", async () => {
    captureLogs();
    const order: string[] = [];
    const handle = io
      .coroutine(async () => {
        defer(() => order.push("defer"));
        await new Promise<void>(() => {}); // invisible to the signal - nothing re-raises here
      })
      .spawn();

    handle.cancel();
    const outcome = caught(handle); // observe before the reaper rejects
    await advance(5_000); // reaped: the caller is released...
    expect(await outcome).toBeInstanceOf(CancelledError);
    await advance(60_000); // ...but no amount of additional time unwinds the body
    // Unlike io.sleep (which re-raises on cancel), the raw await never unwinds,
    // so the cleanup is unreachable.
    expect(order).toEqual([]);
  });

  test("a reaped zombie that later un-wedges still runs its defers, but its outcome is discarded", async () => {
    captureLogs();
    let release!: () => void;
    const order: string[] = [];
    const handle = io
      .coroutine(async () => {
        defer(() => order.push("late defer"));
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return "late success";
      })
      .spawn();

    handle.cancel();
    const outcome = caught(handle); // observe before the reaper rejects
    await advance(5_000);
    expect(await outcome).toBeInstanceOf(CancelledError); // reaper settled the caller
    expect(order).toEqual([]); // body still parked: cleanup unreachable

    release(); // the "frozen" promise finally resolves
    await flush(); // let the abandoned body unwind (no timers involved)
    expect(order).toEqual(["late defer"]); // defers run late, detached from any caller
    // Cancellation wins + external already settled: the late "late success" is discarded.
    expect(await caught(handle)).toBeInstanceOf(CancelledError);
  });

  test("killing a parent that is awaiting a frozen child settles via the parent's own reaper (subtree abandoned)", async () => {
    const entries = captureLogs();
    const handle = io
      .coroutine(async () => {
        // Awaited (not backgrounded): the parent body is stuck on the child's result.
        // Cancelling the parent aborts the child's scope but never calls the child
        // handle's cancel(), so no child reaper exists - the PARENT's reaper must be
        // what unblocks the caller.
        await io
          .coroutine(async () => {
            await new Promise<void>(() => {});
          })
          .spawn();
      })
      .spawn();

    handle.cancel();
    const outcome = caught(handle);
    await advance(5_000); // the parent's default budget - the child never got a reaper
    expect(await outcome).toBeInstanceOf(CancelledError);
    expect(entries.some((e) => e.level === "warn" && e.fields?.code === "coroutine_hung")).toBe(
      true,
    );
  });
});
