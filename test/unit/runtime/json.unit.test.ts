import { describe, expect, test } from "bun:test";
import { cloneJsonValue, toJsonValue } from "../../../packages/brewva-runtime/src/utils/json.js";

describe("runtime json helpers", () => {
  test("cloneJsonValue returns a detached clone for canonical JSON values", () => {
    const canonical = toJsonValue({
      nested: {
        list: ["alpha", { ok: true }],
      },
    });

    const cloned = cloneJsonValue(canonical);
    expect(cloned).toEqual(canonical);

    if (!Array.isArray(cloned) && cloned && typeof cloned === "object") {
      const nested = cloned["nested"];
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        const list = nested["list"];
        if (Array.isArray(list)) {
          list.push("beta");
        }
      }
    }

    expect(canonical).toEqual({
      nested: {
        list: ["alpha", { ok: true }],
      },
    });
  });
});
