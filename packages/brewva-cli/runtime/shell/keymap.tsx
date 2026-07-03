/** @jsxImportSource @opentui/solid */

import { appendFileSync } from "node:fs";
import type { JSX } from "solid-js";
import type { ShellEffect } from "../../src/shell/domain/effects.js";
import type { ShellRendererController } from "../../src/shell/domain/renderer-contract.js";
import {
  TRANSCRIPT_NAV_DIRECTION_BY_COMMAND_ID,
  type TranscriptNavDirection,
} from "../../src/shell/domain/transcript-navigation.js";
import type {
  BrewvaKeymapBindingDefinition,
  BrewvaKeymapLayer,
  BrewvaResolvedKeymapBindings,
} from "../../src/shell/domain/tui.js";
import type { OpenTuiRenderer } from "../internal-opentui-runtime.js";
import {
  createDefaultOpenTuiKeymap,
  formatCommandBindings,
  formatKeySequence,
  KeymapProvider,
  opentuiKeymapAddons,
  type Binding,
  type CliRenderer,
  type KeyEvent,
  type Keymap,
  type Layer,
  type Renderable,
} from "../opentui/index.js";

const BREWVA_MODE_KEY = "brewva.mode";
const BREWVA_BASE_MODE = "composer";
const LEADER_TOKEN = "leader";

/**
 * Keyboard-path diagnostics for "keys do nothing on this machine" reports the
 * test harness cannot reproduce: `BREWVA_KEYMAP_DEBUG=1` logs every resolved
 * key event, dispatched effect, and mode switch to stderr (test harness), and
 * `BREWVA_KEYMAP_DEBUG=/path/to/file` appends to that file instead — the
 * interactive shell owns the alternate screen, so stderr would corrupt it.
 */
function isKeymapDebugEnabled(): boolean {
  const value = process.env.BREWVA_KEYMAP_DEBUG;
  return typeof value === "string" && value.length > 0;
}

function keymapDebugLog(message: string): void {
  const target = process.env.BREWVA_KEYMAP_DEBUG;
  const line = `[keymap-debug] ${message}`;
  if (!target || target === "1") {
    console.error(line);
    return;
  }
  try {
    appendFileSync(target, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Diagnostics must never break input handling.
  }
}

const LAYER_PRIORITY: Readonly<Record<BrewvaKeymapLayer, number>> = {
  global: 0,
  composer: 10,
  transcript: 15,
  completion: 20,
  overlay: 30,
  pager: 40,
  subagentFooter: 45,
  selection: 50,
};
const TEXTAREA_LAYER_PRIORITY = LAYER_PRIORITY.composer - 1;
const BREWVA_OWNED_TEXTAREA_COMMANDS = new Set(["input.newline", "input.submit"]);

export const BrewvaKeymapProvider = KeymapProvider;

export type BrewvaOpenTuiKeymap = Keymap<Renderable, KeyEvent>;

export interface BrewvaKeymapController {
  readonly keymap: BrewvaOpenTuiKeymap;
  setMode(mode: BrewvaKeymapLayer): void;
  dispose(): void;
}

export interface RegisterBrewvaKeymapInput {
  renderer: OpenTuiRenderer;
  runtime: ShellRendererController;
  copySelection(): Promise<boolean>;
  clearSelection(): void;
  syncComposerFromEditor(): Promise<void>;
  navigateTranscriptMessage(direction: TranscriptNavDirection): void;
}

export function formatBrewvaKeySequence(parts: Parameters<typeof formatKeySequence>[0]): string {
  return formatKeySequence(parts, {
    tokenDisplay: {
      [LEADER_TOKEN]: "leader",
    },
    keyNameAliases: {
      pageup: "pgup",
      pagedown: "pgdn",
      return: "enter",
    },
    modifierAliases: {
      meta: "alt",
    },
  });
}

export function formatBrewvaCommandBindings(
  bindings: Parameters<typeof formatCommandBindings>[0],
): string | undefined {
  return formatCommandBindings(bindings, {
    tokenDisplay: {
      [LEADER_TOKEN]: "leader",
    },
    keyNameAliases: {
      pageup: "pgup",
      pagedown: "pgdn",
      return: "enter",
    },
    modifierAliases: {
      meta: "alt",
    },
  });
}

function effectCommand(
  runtime: ShellRendererController,
  effect: ShellEffect,
  beforeDispatch?: (effect: ShellEffect) => Promise<void>,
) {
  return () => {
    if (isKeymapDebugEnabled()) {
      keymapDebugLog(`dispatch effect=${effect.type}`);
    }
    void (async () => {
      await beforeDispatch?.(effect);
      if (effect.type === "composer.submit") {
        runtime.submitComposer();
        return;
      }
      await runtime.handleInput({ type: "keymap.effect", effect });
    })();
    return true;
  };
}

function shellCommand(runtime: ShellRendererController, commandId: string) {
  return () => {
    void runtime.handleInput({ type: "keymap.command", commandId, source: "keybinding" });
    return true;
  };
}

function bindingCommand(
  runtime: ShellRendererController,
  definition: BrewvaKeymapBindingDefinition,
  beforeDispatch?: (effect: ShellEffect) => Promise<void>,
) {
  if (definition.effect) {
    return effectCommand(runtime, definition.effect, beforeDispatch);
  }
  return shellCommand(runtime, definition.id);
}

export function shortcutForOpenTuiKeymap(shortcut: string): string {
  return shortcut
    .trim()
    .split(/\s+/u)
    .map((part) => (part === LEADER_TOKEN ? `<${LEADER_TOKEN}>` : part))
    .join("");
}

function bindingsForLayer(
  runtime: ShellRendererController,
  definitions: readonly BrewvaKeymapBindingDefinition[],
  layer: BrewvaKeymapLayer,
  beforeDispatch?: (effect: ShellEffect) => Promise<void>,
): Binding<Renderable, KeyEvent>[] {
  return definitions
    .filter((definition) => (definition.layer ?? "global") === layer)
    .flatMap((definition) =>
      definition.shortcuts.map((shortcut) => ({
        key: shortcutForOpenTuiKeymap(shortcut),
        cmd: bindingCommand(runtime, definition, beforeDispatch),
        desc: definition.title,
      })),
    );
}

function registerModeLayerField(keymap: BrewvaOpenTuiKeymap): () => void {
  return keymap.registerLayerFields({
    mode(value, ctx) {
      ctx.require(BREWVA_MODE_KEY, value);
    },
  });
}

function registerLayer(
  keymap: BrewvaOpenTuiKeymap,
  runtime: ShellRendererController,
  bindings: BrewvaResolvedKeymapBindings,
  layer: BrewvaKeymapLayer,
  beforeDispatch?: (effect: ShellEffect) => Promise<void>,
  activeMode: BrewvaKeymapLayer = layer,
): () => void {
  const layerConfig: Layer<Renderable, KeyEvent> = {
    priority: LAYER_PRIORITY[layer],
    bindings: bindingsForLayer(runtime, bindings.definitions, layer, beforeDispatch),
  };
  if (activeMode !== "global") {
    layerConfig.mode = activeMode;
  }
  return keymap.registerLayer(layerConfig);
}

function registerKeyAliases(keymap: BrewvaOpenTuiKeymap): () => void {
  const aliases = {
    enter: "return",
    esc: "escape",
    pgdown: "pagedown",
    pgup: "pageup",
  } as const;
  return keymap.appendBindingExpander((ctx) => {
    const expanded = Object.entries(aliases).reduce(
      (acc, [alias, key]) =>
        acc.replace(new RegExp(`(^|[+,\\s>])${alias}(?=$|[+,\\s<])`, "giu"), `$1${key}`),
      ctx.input,
    );
    return expanded === ctx.input ? undefined : [{ key: expanded, displays: ctx.displays }];
  });
}

function replaceDefaultEventResolverWithImeSafeResolver(keymap: BrewvaOpenTuiKeymap): () => void {
  // OpenTUI's default resolver normalizes event.name through resolveKey().
  // Raw IME commits can carry the committed text in sequence while leaving name
  // empty, so they must be treated as "no keymap match" instead of an invalid key.
  keymap.clearEventMatchResolvers();
  return keymap.appendEventMatchResolver((event, ctx) => {
    const keyName = event.name.trim();
    if (isKeymapDebugEnabled()) {
      keymapDebugLog(
        `event name=${JSON.stringify(event.name)} ctrl=${event.ctrl} shift=${event.shift} meta=${event.meta}`,
      );
    }
    if (!keyName) {
      return [];
    }
    return [
      ctx.resolveKey({
        name: keyName,
        ctrl: event.ctrl,
        shift: event.shift,
        meta: event.meta,
        super: event.super ?? false,
        hyper: event.hyper || undefined,
      }),
    ];
  });
}

/**
 * Registers the OpenTUI default edit-buffer bindings (cursor movement, word ops,
 * kill/yank, select, etc.) as a textarea layer for each given keymap `mode`.
 *
 * The full editing key set stays available whenever a composer/completion mode
 * is active. brewva commands never live on bare editing keys — they use the
 * leader prefix or non-editing ctrl chords — so the few keys brewva owns are
 * already won by its higher-priority command layers; no reserved-key filtering
 * is needed. Only `input.newline`/`input.submit` are dropped, because the
 * composer command layer drives Enter (submit) and Ctrl+J (newline) itself —
 * this also keeps the default meta+enter / kp-enter submit bindings from
 * sneaking back in.
 *
 * Gating on keymap `mode` rather than a runtime focus check (opencode's
 * approach) is deliberate: brewva already maintains a mode stack where
 * composer/completion are exactly the input-focused surfaces, while overlay /
 * pager / subagentFooter modes are not — so the mode gate gives the same
 * "active only while editing" guarantee without depending on renderer focus
 * state. The edit-buffer commands and textarea suspension are reference-counted
 * per keymap, so they are registered once and a single binding set is shared
 * across the modes. Covered by keymap-config.unit.test.ts.
 */
function registerManagedTextareaLayers(
  keymap: BrewvaOpenTuiKeymap,
  renderer: CliRenderer,
  modes: readonly ("composer" | "completion")[],
): () => void {
  const offCommands = opentuiKeymapAddons.registerEditBufferCommands(keymap, renderer);
  const offSuspension = opentuiKeymapAddons.registerTextareaMappingSuspension(keymap, renderer);
  try {
    const bindings = (
      opentuiKeymapAddons.createTextareaBindings() as Binding<Renderable, KeyEvent>[]
    ).filter(
      (binding) =>
        typeof binding.cmd !== "string" || !BREWVA_OWNED_TEXTAREA_COMMANDS.has(binding.cmd),
    );
    const offLayers = modes.map((mode) =>
      keymap.registerLayer({ priority: TEXTAREA_LAYER_PRIORITY, mode, bindings }),
    );
    return () => {
      for (const offLayer of offLayers.toReversed()) {
        offLayer();
      }
      offSuspension();
      offCommands();
    };
  } catch (error) {
    offSuspension();
    offCommands();
    throw error;
  }
}

export function registerBrewvaKeymap(input: RegisterBrewvaKeymapInput): BrewvaKeymapController {
  const keymap = createDefaultOpenTuiKeymap(input.renderer as CliRenderer);
  keymap.setData(BREWVA_MODE_KEY, BREWVA_BASE_MODE);
  const disposers: (() => void)[] = [];
  const config = input.runtime.getTuiConfig();
  const bindings = input.runtime.getKeymapBindings();
  const renderer = input.renderer as CliRenderer;

  disposers.push(registerModeLayerField(keymap));
  disposers.push(replaceDefaultEventResolverWithImeSafeResolver(keymap));
  disposers.push(opentuiKeymapAddons.registerCommaBindings(keymap));
  disposers.push(registerKeyAliases(keymap));
  disposers.push(opentuiKeymapAddons.registerBaseLayoutFallback(keymap));
  disposers.push(
    opentuiKeymapAddons.registerTimedLeader(keymap, {
      trigger: config.keymap.leader,
      name: LEADER_TOKEN,
      timeoutMs: config.keymap.leaderTimeoutMs,
    }),
  );
  disposers.push(opentuiKeymapAddons.registerEscapeClearsPendingSequence(keymap));
  disposers.push(opentuiKeymapAddons.registerBackspacePopsPendingSequence(keymap));
  disposers.push(registerManagedTextareaLayers(keymap, renderer, ["composer", "completion"]));
  disposers.push(
    keymap.registerLayer({
      priority: LAYER_PRIORITY.selection,
      mode: "selection",
      bindings: bindings.definitions
        .filter((definition) => (definition.layer ?? "global") === "selection")
        .flatMap((definition) =>
          definition.shortcuts.map((shortcut) => ({
            key: shortcutForOpenTuiKeymap(shortcut),
            cmd: () => {
              if (definition.id === "selection.copy") {
                void input.copySelection();
                return true;
              }
              if (definition.id === "selection.clear") {
                input.clearSelection();
                return true;
              }
              return false;
            },
            desc: definition.title,
          })),
        ),
    }),
  );
  disposers.push(
    keymap.registerLayer({
      priority: LAYER_PRIORITY.transcript,
      mode: BREWVA_BASE_MODE,
      bindings: bindings.definitions
        .filter((definition) => (definition.layer ?? "global") === "transcript")
        .flatMap((definition) =>
          definition.shortcuts.map((shortcut) => ({
            key: shortcutForOpenTuiKeymap(shortcut),
            cmd: () => {
              const direction = TRANSCRIPT_NAV_DIRECTION_BY_COMMAND_ID[definition.id];
              if (!direction) {
                return false;
              }
              input.navigateTranscriptMessage(direction);
              return true;
            },
            desc: definition.title,
          })),
        ),
    }),
  );
  const beforeDispatch = async (effect: ShellEffect) => {
    // Any effect that reads or submits composer text must observe the
    // textarea's latest content, not the debounced editor-sync echo —
    // otherwise trailing keystrokes are silently dropped from the
    // submitted prompt or the accepted completion splice.
    if (
      effect.type === "composer.submit" ||
      effect.type === "completion.submit" ||
      effect.type === "completion.accept"
    ) {
      await input.syncComposerFromEditor();
    }
  };
  for (const layer of [
    "global",
    "composer",
    "completion",
    "overlay",
    "pager",
    "subagentFooter",
  ] as const) {
    disposers.push(registerLayer(keymap, input.runtime, bindings, layer, beforeDispatch));
  }
  disposers.push(
    registerLayer(keymap, input.runtime, bindings, "composer", beforeDispatch, "completion"),
  );
  disposers.push(
    registerLayer(keymap, input.runtime, bindings, "overlay", beforeDispatch, "pager"),
  );

  return {
    keymap,
    setMode(mode) {
      if (isKeymapDebugEnabled()) {
        keymapDebugLog(`setMode(${mode})`);
      }
      keymap.setData(BREWVA_MODE_KEY, mode);
    },
    dispose() {
      for (const dispose of disposers.toReversed()) {
        dispose();
      }
    },
  };
}

export function createBrewvaKeymapController(
  input: RegisterBrewvaKeymapInput,
): BrewvaKeymapController {
  return registerBrewvaKeymap(input);
}

export function BrewvaKeymapRoot(input: {
  controller: BrewvaKeymapController;
  children: JSX.Element;
}) {
  return (
    <BrewvaKeymapProvider keymap={input.controller.keymap}>{input.children}</BrewvaKeymapProvider>
  );
}
