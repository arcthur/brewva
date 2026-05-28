import { describe, expect, test } from "bun:test";
import { OPEN_TUI_INTERACTIVE_RENDER_TARGET_FPS } from "../../../packages/brewva-cli/runtime/internal-opentui-runtime.js";

describe("internal opentui runtime", () => {
  test("uses a 60 fps interactive target for responsive transcript scrolling", () => {
    expect(OPEN_TUI_INTERACTIVE_RENDER_TARGET_FPS).toBe(60);
  });
});
