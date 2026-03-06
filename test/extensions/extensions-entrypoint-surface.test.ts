import { describe, expect, test } from "bun:test";

describe("extensions entrypoint surface", () => {
  test("does not expose removed memory bridge hook", async () => {
    const extensions = await import("@brewva/brewva-extensions");
    expect("registerMemoryBridge" in extensions).toBe(false);
  });
});
