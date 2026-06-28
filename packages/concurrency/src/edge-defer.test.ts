import { describe, expect, test } from "bun:test";
import { defer, io } from "./index";

const origError = console.error;

function captureErrors(): { messages: unknown[]; restore: () => void } {
  const messages: unknown[] = [];
  console.error = (...args: unknown[]) => {
    messages.push(args);
  };
  return { messages, restore: () => (console.error = origError) };
}

describe("defer edges", () => {
  test("defer() outside a coroutine is a no-op (does not throw)", () => {
    expect(() => defer(() => {})).not.toThrow();
  });

  test("a throwing sync defer does not abort the rest of the LIFO chain", async () => {
    const order: string[] = [];
    const { restore } = captureErrors();
    try {
      await io
        .coroutine(async () => {
          defer(() => order.push("first-registered"));
          defer(() => {
            throw new Error("defer boom");
          });
          defer(() => order.push("last-registered"));
        })
        .spawn();
    } finally {
      restore();
    }
    // LIFO: last-registered runs, the middle one throws (swallowed), first still runs.
    expect(order).toEqual(["last-registered", "first-registered"]);
  });

  test("an async defer that rejects is swallowed and the chain continues", async () => {
    const order: string[] = [];
    const { restore } = captureErrors();
    try {
      await io
        .coroutine(async () => {
          defer(() => order.push("first-registered"));
          defer(async () => {
            await io.sleep(1);
            throw new Error("async defer boom");
          });
          defer(() => order.push("last-registered"));
        })
        .spawn();
    } finally {
      restore();
    }
    expect(order).toEqual(["last-registered", "first-registered"]);
  });
});
