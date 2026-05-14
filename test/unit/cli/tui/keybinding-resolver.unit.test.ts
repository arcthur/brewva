import { describe, expect, test } from "bun:test";
import {
  createKeybindingResolver,
  type KeybindingContext,
  type KeybindingTrigger,
} from "../../../../packages/brewva-cli/src/internal/tui/index.js";

const trigger = (key: string): KeybindingTrigger => ({
  key,
  ctrl: false,
  meta: false,
  shift: false,
});

describe("tui keybinding resolver", () => {
  test("prefers the most specific active context before bubbling to parent contexts", () => {
    const resolver = createKeybindingResolver([
      {
        id: "global.submit",
        context: "global",
        trigger: trigger("enter"),
        action: "submit",
      },
      {
        id: "overlay.close",
        context: "overlay",
        trigger: trigger("enter"),
        action: "closeOverlay",
      },
    ]);

    const contextChain: KeybindingContext[] = ["overlay", "composer", "global"];
    expect(resolver.resolve(contextChain, trigger("enter"))?.action).toBe("closeOverlay");
  });

  test("falls back to a parent context when the active context has no matching binding", () => {
    const resolver = createKeybindingResolver([
      {
        id: "global.submit",
        context: "global",
        trigger: trigger("enter"),
        action: "submit",
      },
    ]);

    const contextChain: KeybindingContext[] = ["completion", "composer", "global"];
    expect(resolver.resolve(contextChain, trigger("enter"))?.action).toBe("submit");
  });
});
