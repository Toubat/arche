import { expect, test } from "bun:test";
import { greet } from "./index";

test("greet returns a greeting", () => {
  expect(greet("arche")).toBe("Hello, arche!");
});
