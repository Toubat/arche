import { afterEach, describe, expect, test } from "bun:test";
import { defer, io } from "./index";

const realWarn = console.warn;
afterEach(() => {
  console.warn = realWarn;
});

function captureWarnings(): string[] {
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  return warnings;
}

describe("defer timeout", () => {
  test("the defer chain has a total budget: the cleanup signal aborts and remaining defers are skipped + warned", async () => {
    const warnings = captureWarnings();
    const events: string[] = [];

    await io
      .coroutine(async () => {
        // Registered first => runs LAST (LIFO); should be skipped once the budget is exhausted.
        defer(() => {
          events.push("A");
        });
        // Registered last => runs FIRST; overruns the defer budget on a cleanup sleep.
        defer(async () => {
          events.push("B-start");
          try {
            await io.sleep(1000);
          } catch {
            events.push("B-aborted");
          }
        });
        return "done";
      })
      .spawn({ deferTimeout: 30 });

    expect(events).toContain("B-start");
    expect(events).toContain("B-aborted");
    expect(events).not.toContain("A");
    expect(warnings.some((w) => w.includes("defer timeout"))).toBe(true);
  });

  test("defers within the budget all run normally", async () => {
    const events: string[] = [];
    await io
      .coroutine(async () => {
        defer(() => {
          events.push("A");
        });
        defer(async () => {
          await io.sleep(5);
          events.push("B");
        });
        return "done";
      })
      .spawn({ deferTimeout: 1000 });

    expect(events).toEqual(["B", "A"]);
  });
});
