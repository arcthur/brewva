import { describe, expect, test } from "bun:test";
import { opentuiKeymapAddons } from "../../../../packages/brewva-cli/runtime/opentui/index.js";
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

// brewva drives Enter (submit) and Ctrl+J (newline) through its own command
// layer, so those two edit-buffer commands are intentionally NOT left to the
// textarea layer. Keep in sync with BREWVA_OWNED_TEXTAREA_COMMANDS in keymap.tsx.
const BREWVA_OWNED_TEXTAREA_COMMANDS = new Set(["input.newline", "input.submit"]);

// Every key the OpenTUI managed textarea layer actually binds (cursor / word /
// kill / select / delete / …), derived from the live default bindings so the
// guard below stays complete even as OpenTUI grows its editing key set. Keys
// brewva owns (Enter / Ctrl+J) are excluded.
function textareaEditingKeys(): Set<string> {
  return new Set(
    (opentuiKeymapAddons.createTextareaBindings() as Array<{ key: unknown; cmd: unknown }>)
      .filter(
        (binding) =>
          typeof binding.key === "string" &&
          !(typeof binding.cmd === "string" && BREWVA_OWNED_TEXTAREA_COMMANDS.has(binding.cmd)),
      )
      .map((binding) => binding.key as string),
  );
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
        "overlay.pageUp": "pgup",
      },
    });

    expect(bindings.get("app.commandPalette")).toEqual(["leader p"]);
    expect(bindings.get("app.help")).toEqual([]);
    expect(bindings.get("selection.copy")).toEqual([]);
    expect(bindings.get("overlay.pageUp")).toEqual(["pageup"]);
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
        "overlay.pageDown",
        "selection.copy",
      ]),
    );
  });

  test("migrates editing-key commands to leader / non-editing chords", () => {
    const bindings = buildBrewvaKeymapBindings({ commandBindings: commandBindings() });
    // Regression: these used to sit on bare textarea editing keys (ctrl+a/e/k,
    // home/end), shadowing cursor movement and kill/line ops in the composer.
    expect(bindings.get("operator.approvals")).toEqual(["leader a"]);
    expect(bindings.get("composer.editor")).toEqual(["leader e"]);
    expect(bindings.get("session.queue")).toEqual(["leader q"]);
    expect(bindings.get("app.commandPalette")).toEqual(["ctrl+p"]);
  });

  test("keeps global and composer commands off bare textarea editing keys", () => {
    // The managed textarea layer no longer filters reserved keys, so a global or
    // composer command sitting on a textarea editing key would silently steal it
    // back from the textarea. Guard that against the FULL OpenTUI editing key set.
    const editingKeys = textareaEditingKeys();
    // Sanity: the derived set really covers the keys this fix restored.
    for (const key of ["up", "down", "home", "end", "ctrl+a", "ctrl+e", "ctrl+k"]) {
      expect(editingKeys.has(key)).toBe(true);
    }
    const bindings = buildBrewvaKeymapBindings({ commandBindings: commandBindings() });
    const offenders = bindings.definitions
      .filter((definition) => {
        const layer = definition.layer ?? "global";
        return layer === "global" || layer === "composer";
      })
      .flatMap((definition) =>
        definition.shortcuts
          .map((shortcut) => shortcutForOpenTuiKeymap(shortcut))
          .filter((key) => editingKeys.has(key))
          .map((key) => `${definition.id}:${key}`),
      );
    expect(offenders).toEqual([]);
  });

  test("no shortcut is bound twice across the layers active in the composer base mode", () => {
    // global (always on), composer, and transcript are all active during normal
    // typing (transcript/composer register at mode=composer in keymap.tsx). A
    // shortcut bound twice across them means the higher-priority layer silently
    // shadows the other — the leader-b regression where transcript.message.last
    // (priority 15) shadowed subagentFooter.toggle (global, priority 0) into a
    // dead internal binding. Guard so it cannot recur unnoticed.
    const baseActiveLayers = new Set(["global", "composer", "transcript"]);
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const definition of BREWVA_BUILT_IN_KEYMAP_BINDINGS) {
      const layer = definition.layer ?? "global";
      if (!baseActiveLayers.has(layer)) {
        continue;
      }
      for (const shortcut of definition.shortcuts) {
        const token = shortcutForOpenTuiKeymap(shortcut);
        const existing = seen.get(token);
        if (existing) {
          collisions.push(`"${shortcut}" (${token}): ${existing} vs ${definition.id}`);
        } else {
          seen.set(token, definition.id);
        }
      }
    }
    expect(collisions).toEqual([]);
  });
});
