import { describe, expect, test } from "bun:test";
import { CancelledError, ConcurrencyError, defer, io, type RoutineHandle } from "./index";

async function caught(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

describe("cancellation wins over a swallowed CancelledError", () => {
  test("a body that catches CancelledError and returns a value still settles CancelledError", async () => {
    const handle = io
      .coroutine(async () => {
        try {
          await io.sleep(1000);
        } catch {
          // Swallow the injected cancellation and try to report success anyway.
        }
        return "i ignored the cancellation";
      })
      .spawn();

    handle.cancel();

    // A cancelled coroutine must not appear successful.
    expect(await caught(handle)).toBeInstanceOf(CancelledError);
    expect(handle.cancelled).toBe(true);
  });

  test("a different error thrown while cancelled is preserved as-is", async () => {
    const boom = new Error("boom");
    const handle = io
      .coroutine(async () => {
        try {
          await io.sleep(1000);
        } catch {
          throw boom;
        }
      })
      .spawn();
    handle.cancel();
    expect(await caught(handle)).toBe(boom);
  });

  test("level-triggered: after cancellation, the next io.sleep re-raises immediately", async () => {
    const events: string[] = [];
    const handle = io
      .coroutine(async () => {
        try {
          await io.sleep(1000);
        } catch {
          events.push("first sleep cancelled");
        }
        // Already-cancelled scope: this must re-raise immediately, not wait 1s.
        await io.sleep(1000);
        events.push("unreachable");
      })
      .spawn();
    handle.cancel();
    expect(await caught(handle)).toBeInstanceOf(CancelledError);
    expect(events).toEqual(["first sleep cancelled"]);
  });
});

describe("spawn short-circuit on an already-aborted scope", () => {
  test("a coroutine spawned into an already-aborted scope never runs its body", async () => {
    let childBodyRan = false;
    let childHandle: RoutineHandle<string> | undefined;

    const parent = io
      .coroutine(async () => {
        try {
          await io.sleep(1000);
        } catch {
          // The parent is now cancelled; its scope signal is already aborted.
          childHandle = io
            .coroutine(async () => {
              childBodyRan = true;
              return "child value";
            })
            .spawn();
          await childHandle;
        }
      })
      .spawn();

    parent.cancel();
    await caught(parent);

    expect(childBodyRan).toBe(false);
    expect(await caught(childHandle as RoutineHandle<string>)).toBeInstanceOf(CancelledError);
    expect((childHandle as RoutineHandle<string>).cancelled).toBe(true);
  });
});

describe("io.context() surface", () => {
  test("io.context().cancelled reflects the live cancellation state", async () => {
    let seenBefore = true;
    let seenAfter = false;
    const handle = io
      .coroutine(async () => {
        const ctx = io.context();
        seenBefore = ctx.cancelled;
        try {
          await io.sleep(1000);
        } catch {
          seenAfter = ctx.cancelled;
          throw new Error("done");
        }
      })
      .spawn();
    handle.cancel();
    await caught(handle);
    expect(seenBefore).toBe(false);
    expect(seenAfter).toBe(true);
  });

  test("io.context().throwIfCancelled() is a cooperative checkpoint for raw work", async () => {
    const handle = io
      .coroutine(async () => {
        const ctx = io.context();
        // Tight loop with no framework await; cooperate explicitly.
        for (let i = 0; i < 1_000_000; i++) {
          if (i % 1000 === 0) ctx.throwIfCancelled();
          await Promise.resolve();
        }
        return "finished";
      })
      .spawn();
    handle.cancel();
    expect(await caught(handle)).toBeInstanceOf(CancelledError);
  });

  test("io.context().signal can be threaded into a raw abortable operation", async () => {
    const rawError = new Error("aborted raw op");
    const handle = io
      .coroutine(async () => {
        const ctx = io.context();
        // A raw promise that only settles when the threaded signal aborts, proving
        // ctx.signal reaches code the framework cannot otherwise interrupt.
        await new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(rawError), { once: true });
        });
      })
      .spawn();
    handle.cancel();
    // The body threw a non-Cancelled error; it is preserved as-is (diagnostics).
    expect(await caught(handle)).toBe(rawError);
    expect(handle.cancelled).toBe(true);
  });

  test("io.context() throws when called outside a coroutine", () => {
    expect(() => io.context()).toThrow(ConcurrencyError);
  });

  test("io.context() inside a defer sees the shielded (non-aborted) cleanup signal", async () => {
    let cleanupCancelled = true;
    const handle = io
      .coroutine(async () => {
        defer(() => {
          // Cleanup runs shielded: even though the coroutine was cancelled, the
          // ambient context here is the fresh cleanup context.
          cleanupCancelled = io.context().cancelled;
        });
        await io.sleep(1000);
      })
      .spawn();
    handle.cancel();
    await caught(handle);
    expect(cleanupCancelled).toBe(false);
  });
});
