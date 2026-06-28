import { describe, expect, test } from "bun:test";
import { CancelledError, ChannelClosedError, io } from "./index";

async function caught(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

describe("io.channel (buffered)", () => {
  test("send then receive preserves FIFO order without blocking under capacity", async () => {
    const ch = io.channel<number>({ capacity: 3 });
    await ch.send(1);
    await ch.send(2);
    await ch.send(3);
    expect(await ch.receive()).toBe(1);
    expect(await ch.receive()).toBe(2);
    expect(await ch.receive()).toBe(3);
  });

  test("a full buffer blocks send until a receive frees a slot, keeping order", async () => {
    const ch = io.channel<number>({ capacity: 1 });
    await ch.send(10);
    let sentSecond = false;
    const pending = ch.send(20).then(() => {
      sentSecond = true;
    });
    // Buffer is full, so the second send is parked.
    await Promise.resolve();
    expect(sentSecond).toBe(false);
    expect(await ch.receive()).toBe(10);
    await pending;
    expect(sentSecond).toBe(true);
    expect(await ch.receive()).toBe(20);
  });
});

describe("io.channel (rendezvous, capacity 0)", () => {
  test("send blocks until a receiver takes the value", async () => {
    const ch = io.channel<string>();
    let delivered = false;
    const send = ch.send("ping").then(() => {
      delivered = true;
    });
    await Promise.resolve();
    expect(delivered).toBe(false);
    expect(await ch.receive()).toBe("ping");
    await send;
    expect(delivered).toBe(true);
  });

  test("receive blocks until a value is sent", async () => {
    const ch = io.channel<string>();
    const received = ch.receive();
    await ch.send("pong");
    expect(await received).toBe("pong");
  });
});

describe("io.channel close", () => {
  test("send after close rejects with ChannelClosedError", async () => {
    const ch = io.channel<number>({ capacity: 1 });
    ch.close();
    expect(ch.closed).toBe(true);
    expect(await caught(ch.send(1))).toBeInstanceOf(ChannelClosedError);
  });

  test("receive after close-and-drain rejects with ChannelClosedError", async () => {
    const ch = io.channel<number>({ capacity: 2 });
    await ch.send(1);
    ch.close();
    // Buffered values are still receivable...
    expect(await ch.receive()).toBe(1);
    // ...then the drained, closed channel rejects.
    expect(await caught(ch.receive())).toBeInstanceOf(ChannelClosedError);
  });

  test("close wakes a blocked receiver with ChannelClosedError", async () => {
    const ch = io.channel<number>();
    const pending = ch.receive();
    ch.close();
    expect(await caught(pending)).toBeInstanceOf(ChannelClosedError);
  });

  test("close rejects a blocked sender with ChannelClosedError", async () => {
    const ch = io.channel<number>({ capacity: 1 });
    await ch.send(1); // fills buffer
    const blocked = ch.send(2); // parks
    ch.close();
    expect(await caught(blocked)).toBeInstanceOf(ChannelClosedError);
  });

  test("close is idempotent", () => {
    const ch = io.channel<number>();
    ch.close();
    ch.close();
    expect(ch.closed).toBe(true);
  });
});

describe("io.channel iteration & consumers", () => {
  test("for-await drains all values and ends cleanly on close", async () => {
    const ch = io.channel<number>({ capacity: 8 });
    for (let i = 0; i < 5; i++) await ch.send(i);
    ch.close();
    const seen: number[] = [];
    for await (const v of ch) seen.push(v);
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });

  test("competing consumers each receive a distinct value", async () => {
    const ch = io.channel<number>();
    const a = ch.receive();
    const b = ch.receive();
    await ch.send(1);
    await ch.send(2);
    const results = [await a, await b].sort((x, y) => x - y);
    expect(results).toEqual([1, 2]);
  });

  test("multiple for-await consumers partition items with no overlap", async () => {
    const ch = io.channel<number>({ capacity: 4 });
    const N = 30;
    const buckets: number[][] = [[], [], []];
    const consumers = buckets.map((out) =>
      io
        .coroutine(async () => {
          for await (const v of ch) out.push(v);
        })
        .spawn(),
    );

    for (let i = 0; i < N; i++) await ch.send(i);
    ch.close();
    await Promise.all(consumers);

    // Disjoint union: every item landed in exactly one consumer, none lost or
    // duplicated.
    const all = buckets.flat().sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: N }, (_, i) => i));
    expect(new Set(all).size).toBe(N);
  });

  test("when some for-await consumers are cancelled mid-stream, no item is lost or duplicated", async () => {
    const ch = io.channel<number>({ capacity: 2 });
    const N = 40;
    const buckets: number[][] = [[], [], [], []];
    const handles = buckets.map((out) =>
      io
        .coroutine(async () => {
          for await (const v of ch) out.push(v);
        })
        .spawn(),
    );

    // Produce in the background so consumption + cancellation interleave with sends.
    const producer = io
      .coroutine(async () => {
        for (let i = 0; i < N; i++) {
          await ch.send(i);
          await io.sleep(1); // pace so cancellation lands mid-stream
        }
        ch.close();
      })
      .spawn();

    // Let a chunk get delivered, then cancel two consumers mid-stream.
    await io.sleep(8);
    handles[0].cancel();
    handles[2].cancel();

    const results = await Promise.all(handles.map((h) => caught(h)));
    await producer;

    // The cancelled consumers reject; the survivors finish cleanly on close.
    expect(results[0]).toBeInstanceOf(CancelledError);
    expect(results[2]).toBeInstanceOf(CancelledError);
    expect(results[1]).toBeUndefined();
    expect(results[3]).toBeUndefined();

    // Every produced item ended up in exactly one bucket (including whatever a
    // cancelled consumer pulled before stopping) -- none lost to an abandoned
    // receiver, none duplicated.
    const all = buckets.flat().sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: N }, (_, i) => i));
    expect(new Set(all).size).toBe(N);

    // The survivors kept consuming after the others were cancelled.
    expect(buckets[1].length + buckets[3].length).toBeGreaterThan(0);
  });
});

describe("io.channel cancellation", () => {
  test("a blocked receive is cancelled and removed so a later send is not lost", async () => {
    const ch = io.channel<number>();
    const handle = io
      .coroutine(async () => {
        return await ch.receive();
      })
      .spawn();
    handle.cancel();
    expect(await caught(handle)).toBeInstanceOf(CancelledError);

    // The cancelled receiver must have unregistered: this send should park, not
    // be silently delivered to the abandoned waiter.
    let delivered = false;
    const send = ch.send(99).then(() => {
      delivered = true;
    });
    await Promise.resolve();
    expect(delivered).toBe(false);
    expect(await ch.receive()).toBe(99);
    await send;
  });

  test("a blocked send is cancellable", async () => {
    const ch = io.channel<number>({ capacity: 1 });
    await ch.send(1);
    const handle = io
      .coroutine(async () => {
        await ch.send(2); // buffer full -> parks
      })
      .spawn();
    handle.cancel();
    expect(await caught(handle)).toBeInstanceOf(CancelledError);
  });

  test("a cancelled parked sender's value never enters the channel", async () => {
    const ch = io.channel<number>({ capacity: 1 });
    await ch.send(1); // fills the buffer
    const handle = io
      .coroutine(async () => {
        await ch.send(2); // buffer full -> parks carrying 2
      })
      .spawn();
    handle.cancel();
    expect(await caught(handle)).toBeInstanceOf(CancelledError);

    // The buffered 1 survives; the cancelled sender's 2 was dropped, so the next
    // freshly sent value (3) is delivered straight after 1 -- never 2.
    expect(await ch.receive()).toBe(1);
    await ch.send(3);
    expect(await ch.receive()).toBe(3);
  });

  test("a receiver parked inside a coroutine is delivered a value normally", async () => {
    const ch = io.channel<number>();
    const handle = io.coroutine(async () => await ch.receive()).spawn();
    await Promise.resolve(); // let the receiver park
    await ch.send(7);
    expect(await handle).toBe(7);
  });

  test("a sender parked inside a coroutine is rejected when the channel closes", async () => {
    const ch = io.channel<number>({ capacity: 1 });
    await ch.send(1); // fill buffer
    const handle = io
      .coroutine(async () => {
        await ch.send(2); // parks
      })
      .spawn();
    await Promise.resolve(); // let the sender park
    ch.close();
    expect(await caught(handle)).toBeInstanceOf(ChannelClosedError);
  });

  test("closing with a parked sender drops its value; only the buffered value drains", async () => {
    const ch = io.channel<number>({ capacity: 1 });
    await ch.send(1); // fill buffer
    const handle = io
      .coroutine(async () => {
        await ch.send(2); // parks carrying 2
      })
      .spawn();
    await Promise.resolve(); // let the sender park
    ch.close();
    expect(await caught(handle)).toBeInstanceOf(ChannelClosedError);

    // The buffered 1 is still drainable after close; the parked sender's 2 was
    // dropped, so the next receive hits the closed-and-drained end -- never 2.
    expect(await ch.receive()).toBe(1);
    expect(await caught(ch.receive())).toBeInstanceOf(ChannelClosedError);
  });

  // Strict "stop the instant you're cancelled" semantics: a blocking channel op
  // in an aborted scope short-circuits (like the coroutine spawn short-circuit)
  // rather than draining a ready buffered value, so the value stays for a live
  // receiver.
  test("strict: a cancelled coroutine does not drain a ready buffered value", async () => {
    const ch = io.channel<number>({ capacity: 1 });
    await ch.send(1); // buffer = [1], a value sitting ready

    let pulledWhileCancelled = false;
    const doomed = io
      .coroutine(async () => {
        try {
          await io.sleep(1000); // cancellation is injected here
        } catch {
          // Swallow the CancelledError, then misbehave: try to take a buffered
          // value even though our scope is now aborted.
        }
        await ch.receive(); // strict: must reject with CancelledError
        pulledWhileCancelled = true; // strict: unreachable
      })
      .spawn();

    await io.sleep(5); // let `doomed` park at sleep(1000)
    doomed.cancel();
    expect(await caught(doomed)).toBeInstanceOf(CancelledError);

    // Strict expectation: the cancelled coroutine took nothing...
    expect(pulledWhileCancelled).toBe(false);

    // ...so the buffered 1 is still available for a live receiver.
    const survivor = io.coroutine(async () => await ch.receive()).spawn();
    expect(await survivor).toBe(1);
  });
});
