import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BREWVA_TUI_CONFIG,
  loadBrewvaTuiConfig,
} from "../../../../packages/brewva-cli/src/shell/config/tui-config.js";

describe("brewva tui config", () => {
  test("merges global, project, and explicit config in precedence order", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-tui-config-"));
    const globalRoot = join(root, "brewva");
    const projectRoot = join(root, "project");
    const explicitConfig = join(root, "explicit-tui.json");
    mkdirSync(globalRoot, { recursive: true });
    mkdirSync(join(projectRoot, ".brewva"), { recursive: true });
    writeFileSync(
      join(globalRoot, "tui.json"),
      JSON.stringify({
        theme: "paper",
        keymap: {
          leader: "ctrl+x",
          bindings: {
            "app.commandPalette": "leader p",
          },
        },
      }),
    );
    writeFileSync(
      join(projectRoot, ".brewva", "tui.json"),
      JSON.stringify({
        keymap: {
          leaderTimeoutMs: 900,
          bindings: {
            "app.help": "leader h",
          },
        },
        input: {
          largePasteThreshold: {
            minLines: 4,
          },
        },
      }),
    );
    writeFileSync(
      explicitConfig,
      JSON.stringify({
        keymap: {
          bindings: {
            "app.commandPalette": "ctrl+p",
          },
        },
        scroll: {
          acceleration: {
            speed: 2,
          },
        },
      }),
    );

    const loaded = loadBrewvaTuiConfig({
      cwd: projectRoot,
      env: {
        XDG_CONFIG_HOME: root,
        BREWVA_TUI_CONFIG: explicitConfig,
      },
    });

    expect(loaded.config.theme).toBe("paper");
    expect(loaded.config.keymap.leader).toBe("ctrl+x");
    expect(loaded.config.keymap.leaderTimeoutMs).toBe(900);
    expect(loaded.config.keymap.bindings["app.commandPalette"]).toBe("ctrl+p");
    expect(loaded.config.keymap.bindings["app.help"]).toBe("leader h");
    expect(loaded.config.input.largePasteThreshold.minLines).toBe(4);
    expect(loaded.config.input.largePasteThreshold.minCharacters).toBe(
      DEFAULT_BREWVA_TUI_CONFIG.input.largePasteThreshold.minCharacters,
    );
    expect(loaded.config.scroll.acceleration.speed).toBe(2);
    expect(loaded.warnings).toEqual([]);
  });

  test("skips invalid config and warns about unknown binding ids", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-tui-config-invalid-"));
    const projectRoot = join(root, "project");
    mkdirSync(join(projectRoot, ".brewva"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".brewva", "tui.json"),
      JSON.stringify({
        keymap: {
          bindings: {
            "missing.command": "ctrl+m",
            "app.help": "leader h",
          },
        },
      }),
    );

    const loaded = loadBrewvaTuiConfig({
      cwd: projectRoot,
      env: {
        XDG_CONFIG_HOME: join(root, "global"),
      },
      knownBindingIds: new Set(["app.help"]),
    });

    expect(loaded.config.keymap.bindings).toEqual({ "app.help": "leader h" });
    expect(loaded.warnings.map((warning) => warning.code)).toEqual(["unknown_binding"]);
  });

  test("normalizes invalid scalar config fields back to defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-tui-config-normalize-"));
    const projectRoot = join(root, "project");
    mkdirSync(join(projectRoot, ".brewva"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".brewva", "tui.json"),
      JSON.stringify({
        keymap: {
          leader: "",
          leaderTimeoutMs: -1,
        },
        input: {
          largePasteThreshold: {
            minLines: 0,
            minCharacters: -10,
          },
        },
        scroll: {
          acceleration: {
            type: "invalid",
            speed: -2,
          },
        },
      }),
    );

    const loaded = loadBrewvaTuiConfig({
      cwd: projectRoot,
      env: {
        XDG_CONFIG_HOME: join(root, "global"),
      },
    });

    expect(loaded.config.keymap.leader).toBe(DEFAULT_BREWVA_TUI_CONFIG.keymap.leader);
    expect(loaded.config.keymap.leaderTimeoutMs).toBe(
      DEFAULT_BREWVA_TUI_CONFIG.keymap.leaderTimeoutMs,
    );
    expect(loaded.config.input.largePasteThreshold).toEqual(
      DEFAULT_BREWVA_TUI_CONFIG.input.largePasteThreshold,
    );
    expect(loaded.config.scroll.acceleration).toEqual(
      DEFAULT_BREWVA_TUI_CONFIG.scroll.acceleration,
    );
  });
});
