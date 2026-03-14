import { describe, expect, test } from "bun:test";

describe("runtime entrypoint surface", () => {
  test("keeps projection internals out of runtime root surface", async () => {
    const runtime = await import("@brewva/brewva-runtime");

    expect("ProjectionEngine" in runtime).toBe(false);
    expect("ProjectionStore" in runtime).toBe(false);
    expect("buildWorkingProjectionSnapshot" in runtime).toBe(false);
    expect("extractProjectionFromEvent" in runtime).toBe(false);
  });
});
