import { describe, expect, test } from "bun:test";
import { shortcutForOpenTuiKeymap } from "../../../../packages/brewva-cli/runtime/shell/keymap.js";
import { ShellCommandProvider } from "../../../../packages/brewva-cli/src/shell/commands/command-provider.js";
import { registerShellCommands } from "../../../../packages/brewva-cli/src/shell/commands/shell-command-registry.js";
import {
  BREWVA_BUILT_IN_KEYMAP_BINDINGS,
  BREWVA_KEY_ALIASES,
  buildBrewvaKeymapBindings,
  formatShortcutLabel,
  normalizeShortcutSequence,
} from "../../../../packages/brewva-cli/src/shell/keymap/keymap-bindings.js";

function commandBindings() {
  const provider = new ShellCommandProvider();
  registerShellCommands(provider);
  return provider.keymapCommandBindings();
}

describe("brewva tui keymap bindings", () => {
  test("normalizes page and escape aliases into canonical key names", () => {
    expect(normalizeShortcutSequence("pgup")).toBe("pageup");
    expect(normalizeShortcutSequence("pgdown")).toBe("pagedown");
    expect(normalizeShortcutSequence("esc")).toBe("escape");
    expect(normalizeShortcutSequence("enter")).toBe("return");
    expect(BREWVA_KEY_ALIASES).toMatchObject({
      esc: "escape",
      enter: "return",
      pgdown: "pagedown",
      pgup: "pageup",
    });
  });

  test("compiles Brewva leader notation into the OpenTUI token grammar", () => {
    expect(shortcutForOpenTuiKeymap("leader h")).toBe("<leader>h");
    expect(shortcutForOpenTuiKeymap("ctrl+k")).toBe("ctrl+k");
  });

  test("applies overrides, disables bindings with none, and rejects duplicates", () => {
    const bindings = buildBrewvaKeymapBindings({
      commandBindings: commandBindings(),
      overrides: {
        "app.commandPalette": "leader p",
        "app.help": "none",
        "selection.copy": "none",
        "surface.pageUp": "pgup",
      },
    });

    expect(bindings.get("app.commandPalette")).toEqual(["leader p"]);
    expect(bindings.get("app.help")).toEqual([]);
    expect(bindings.get("selection.copy")).toEqual([]);
    expect(bindings.get("surface.pageUp")).toEqual(["pageup"]);
    expect(formatShortcutLabel(bindings.get("app.commandPalette")[0])).toBe("Leader P");

    expect(() =>
      buildBrewvaKeymapBindings({
        commandBindings: commandBindings(),
        overrides: {
          "app.commandPalette": "ctrl+k",
          "app.help": "ctrl+k",
        },
      }),
    ).toThrow("Duplicate Brewva TUI shortcut");
  });

  test("keeps command registry and built-in effect ids explicit", () => {
    expect(commandBindings().map((binding) => binding.id)).toEqual(
      expect.arrayContaining([
        "app.commandPalette",
        "app.help",
        "cockpit.archive",
        "cockpit.attention",
      ]),
    );
    expect(BREWVA_BUILT_IN_KEYMAP_BINDINGS.map((binding) => binding.id)).toEqual(
      expect.arrayContaining([
        "app.shortcutOverlay",
        "composer.submit",
        "completion.accept",
        "overlay.close",
        "selection.copy",
        "surface.pageDown",
      ]),
    );
  });
});
