import { afterEach, describe, expect, test } from "bun:test";
import {
  CancelledError,
  defer,
  io,
  type LogFields,
  type LogLevel,
  resetLogger,
  setLogger,
  TimeoutError,
} from "./index";

async function caught(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

describe("io.all", () => {
  test("resolves with results in input order when all succeed", async () => {
    const result = await io.all([
      io.coroutine(async () => {
        await io.sleep(20);
        return "a";
      }),
      io.coroutine(async () => {
        await io.sleep(5);
        return "b";
      }),
    ]);
    expect(result).toEqual(["a", "b"]);
  });

  test("fail-fast: the first rejection tears down the siblings and rejects with that error", async () => {
    const cleaned: string[] = [];
    const boom = new Error("boom");
    const handle = io.all([
      io.coroutine(async () => {
        await io.sleep(5);
        throw boom;
      }),
      io.coroutine(async () => {
        defer(() => cleaned.push("b cleaned"));
        await io.sleep(1000);
        return "b";
      }),
    ]);
    expect(await caught(handle)).toBe(boom);
    expect(cleaned).toEqual(["b cleaned"]);
  });

  test("cancelling the io.all handle cancels every member", async () => {
    const cleaned: string[] = [];
    const handle = io.all([
      io.coroutine(async () => {
        defer(() => cleaned.push("a"));
        await io.sleep(1000);
      }),
      io.coroutine(async () => {
        defer(() => cleaned.push("b"));
        await io.sleep(1000);
      }),
    ]);
    handle.cancel();
    expect(await caught(handle)).toBeInstanceOf(CancelledError);
    expect([...cleaned].sort()).toEqual(["a", "b"]);
  });
});

describe("io.race", () => {
  test("resolves with the first member to settle and tears down the rest", async () => {
    const cleaned: string[] = [];
    const result = await io.race([
      io.coroutine(async () => {
        await io.sleep(5);
        return "fast";
      }),
      io.coroutine(async () => {
        defer(() => cleaned.push("slow cleaned"));
        await io.sleep(1000);
        return "slow";
      }),
    ]);
    expect(result).toBe("fast");
    // The handle only settles after the losing member's teardown completed.
    expect(cleaned).toEqual(["slow cleaned"]);
  });

  test("a rejection can win the race (first to settle, not first to resolve)", async () => {
    const boom = new Error("boom");
    const handle = io.race([
      io.coroutine(async () => {
        await io.sleep(5);
        throw boom;
      }),
      io.coroutine(async () => {
        await io.sleep(1000);
        return "slow";
      }),
    ]);
    expect(await caught(handle)).toBe(boom);
  });
});

describe("io.allSettled", () => {
  test("never rejects; reports per-member status in input order", async () => {
    const boom = new Error("boom");
    const result = await io.allSettled([
      io.coroutine(async () => {
        await io.sleep(5);
        return "ok";
      }),
      io.coroutine(async () => {
        await io.sleep(5);
        throw boom;
      }),
    ]);
    expect(result[0]).toEqual({ status: "fulfilled", value: "ok" });
    expect(result[1]?.status).toBe("rejected");
    expect((result[1] as PromiseRejectedResult).reason).toBe(boom);
  });
});

describe("io.withTimeout", () => {
  test("resolves with the value when the work finishes in time", async () => {
    const result = await io.withTimeout(
      100,
      io.coroutine(async () => {
        await io.sleep(5);
        return "done";
      }),
    );
    expect(result).toBe("done");
  });

  test("rejects with TimeoutError and tears down the work when it overruns", async () => {
    const cleaned: string[] = [];
    const handle = io.withTimeout(
      20,
      io.coroutine(async () => {
        defer(() => cleaned.push("cleaned"));
        await io.sleep(1000);
        return "done";
      }),
    );
    expect(await caught(handle)).toBeInstanceOf(TimeoutError);
    expect(cleaned).toEqual(["cleaned"]);
  });
});

describe("io.withRetry", () => {
  test("resolves on the first successful attempt without retrying", async () => {
    let attempts = 0;
    const result = await io.withRetry(() =>
      io.coroutine(async () => {
        attempts++;
        return "ok";
      }),
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(1);
  });

  test("retries until an attempt succeeds, reporting each retry", async () => {
    let attempts = 0;
    const retried: number[] = [];
    const result = await io.withRetry(
      () =>
        io.coroutine(async () => {
          attempts++;
          if (attempts < 3) throw new Error("flaky");
          return "ok";
        }),
      {
        maxAttempts: 5,
        backoff: "constant",
        baseDelayMs: 1,
        jitter: false,
        onRetry: (_e, attempt) => retried.push(attempt),
      },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(retried).toEqual([1, 2]);
  });

  test("exhausts attempts and rejects with the last error", async () => {
    let attempts = 0;
    const handle = io.withRetry(
      () =>
        io.coroutine(async () => {
          attempts++;
          throw new Error(`fail ${attempts}`);
        }),
      { maxAttempts: 3, baseDelayMs: 0, jitter: false },
    );
    const err = await caught(handle);
    expect((err as Error).message).toBe("fail 3");
    expect(attempts).toBe(3);
  });

  test("stops early when shouldRetry returns false", async () => {
    let attempts = 0;
    const handle = io.withRetry(
      () =>
        io.coroutine(async () => {
          attempts++;
          throw new Error("nope");
        }),
      { maxAttempts: 5, shouldRetry: () => false },
    );
    await caught(handle);
    expect(attempts).toBe(1);
  });

  test("never retries a cancellation", async () => {
    let attempts = 0;
    const handle = io.withRetry(
      () =>
        io.coroutine(async () => {
          attempts++;
          await io.sleep(1000);
          return "x";
        }),
      { maxAttempts: 5 },
    );
    handle.cancel();
    expect(await caught(handle)).toBeInstanceOf(CancelledError);
    expect(attempts).toBe(1);
  });

  test("supports linear and exponential backoff schedules (capped, jittered)", async () => {
    const linearDelays: number[] = [];
    await caught(
      io.withRetry(
        () =>
          io.coroutine(async () => {
            throw new Error("x");
          }),
        {
          maxAttempts: 3,
          backoff: "linear",
          baseDelayMs: 2,
          jitter: false,
          onRetry: (_e, _a, delay) => linearDelays.push(delay),
        },
      ),
    );
    expect(linearDelays).toEqual([2, 4]);

    const expDelays: number[] = [];
    await caught(
      io.withRetry(
        () =>
          io.coroutine(async () => {
            throw new Error("x");
          }),
        {
          maxAttempts: 3,
          backoff: "exponential",
          baseDelayMs: 3,
          maxDelayMs: 5,
          jitter: true,
          onRetry: (_e, _a, delay) => expDelays.push(delay),
        },
      ),
    );
    // exponential: 3, then min(6, 5) = 5; full jitter keeps each in [0, cap).
    expect(expDelays.length).toBe(2);
    expect(expDelays[0]).toBeGreaterThanOrEqual(0);
    expect(expDelays[0]).toBeLessThan(3);
    expect(expDelays[1]).toBeLessThan(5);
  });
});

describe("io.spawn", () => {
  afterEach(() => resetLogger());

  function captureLogs(): Array<{ level: LogLevel; fields?: LogFields }> {
    const entries: Array<{ level: LogLevel; fields?: LogFields }> = [];
    const record = (level: LogLevel) => (_message: string, fields?: LogFields) => {
      entries.push({ level, fields });
    };
    setLogger({
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    });
    return entries;
  }

  test("runs a list of members and can still be awaited for results", async () => {
    const result = await io.spawn([
      io.coroutine(async () => {
        await io.sleep(2);
        return 1;
      }),
      io.coroutine(async () => 2),
    ]);
    expect(result).toEqual([1, 2]);
  });

  test("runs a single coroutine and can be awaited for its result", async () => {
    const result = await io.spawn(
      io.coroutine(async () => {
        await io.sleep(2);
        return 42;
      }),
    );
    expect(result).toBe(42);
  });

  test("a single spawned coroutine is torn down when the enclosing coroutine exits", async () => {
    const cleaned: string[] = [];
    await io
      .coroutine(async () => {
        io.spawn(
          io.coroutine(async () => {
            defer(() => cleaned.push("bg"));
            await io.sleep(1000); // would outlive the parent if not torn down
          }),
        );
        await io.sleep(5); // let the spawned task park, then exit
      })
      .spawn();
    expect(cleaned).toEqual(["bg"]);
  });

  test("members are torn down when the enclosing coroutine exits", async () => {
    const cleaned: string[] = [];
    await io
      .coroutine(async () => {
        io.spawn([
          io.coroutine(async () => {
            defer(() => cleaned.push("bg"));
            await io.sleep(1000); // would outlive the parent if not torn down
          }),
        ]);
        await io.sleep(5); // let the spawned task park, then exit
      })
      .spawn();
    expect(cleaned).toEqual(["bg"]);
  });

  test("logs (does not throw) a non-cancellation failure when the handle is ignored", async () => {
    const logs = captureLogs();
    io.spawn([
      io.coroutine(async () => {
        throw new Error("kaboom");
      }),
    ]);
    // Let the rejection propagate through the logging catch.
    await new Promise((r) => setTimeout(r, 5));
    const errors = logs.filter((e) => e.level === "error" && e.fields?.code === "spawn_error");
    expect(errors.length).toBe(1);
    expect(errors[0]?.fields?.error).toBe("kaboom");
  });

  test("a single ignored coroutine logs its non-cancellation failure", async () => {
    const logs = captureLogs();
    io.spawn(
      io.coroutine(async () => {
        throw new Error("solo-kaboom");
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    const errors = logs.filter((e) => e.level === "error" && e.fields?.code === "spawn_error");
    expect(errors.length).toBe(1);
    expect(errors[0]?.fields?.error).toBe("solo-kaboom");
  });

  test("does not log when spawned members are merely cancelled on teardown", async () => {
    const logs = captureLogs();
    await io
      .coroutine(async () => {
        io.spawn([
          io.coroutine(async () => {
            await io.sleep(1000);
          }),
        ]);
        await io.sleep(5);
      })
      .spawn();
    await new Promise((r) => setTimeout(r, 5));
    expect(logs.filter((e) => e.fields?.code === "spawn_error").length).toBe(0);
  });
});
