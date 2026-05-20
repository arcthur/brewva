/** @jsxImportSource @opentui/solid */

import type { JSX } from "solid-js";
import type { ShellEffect } from "../../src/shell/domain/effects.js";
import type { ShellRendererController } from "../../src/shell/domain/renderer-contract.js";
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

const LAYER_PRIORITY: Readonly<Record<BrewvaKeymapLayer, number>> = {
  global: 0,
  composer: 10,
  completion: 20,
  overlay: 30,
  pager: 40,
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
    void (async () => {
      await beforeDispatch?.(effect);
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

function registerManagedTextareaLayer(
  keymap: BrewvaOpenTuiKeymap,
  renderer: CliRenderer,
  mode: "composer" | "completion",
  reservedKeys: ReadonlySet<string>,
): () => void {
  const offCommands = opentuiKeymapAddons.registerEditBufferCommands(keymap, renderer);
  const offSuspension = opentuiKeymapAddons.registerTextareaMappingSuspension(keymap, renderer);
  try {
    const bindings = (
      opentuiKeymapAddons.createTextareaBindings() as Binding<Renderable, KeyEvent>[]
    ).filter(
      (binding) =>
        (typeof binding.cmd !== "string" || !BREWVA_OWNED_TEXTAREA_COMMANDS.has(binding.cmd)) &&
        (typeof binding.key !== "string" || !reservedKeys.has(binding.key)),
    );
    const offLayer = keymap.registerLayer({
      priority: TEXTAREA_LAYER_PRIORITY,
      mode,
      bindings,
    });
    return () => {
      offLayer();
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
  const reservedTextareaKeys = new Set(
    bindings.definitions.flatMap((definition) =>
      definition.shortcuts.map((shortcut) => shortcutForOpenTuiKeymap(shortcut)),
    ),
  );

  disposers.push(registerModeLayerField(keymap));
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
  disposers.push(registerManagedTextareaLayer(keymap, renderer, "composer", reservedTextareaKeys));
  disposers.push(
    registerManagedTextareaLayer(keymap, renderer, "completion", reservedTextareaKeys),
  );
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
  const beforeDispatch = async (effect: ShellEffect) => {
    if (effect.type === "composer.submit") {
      await input.syncComposerFromEditor();
    }
  };
  for (const layer of ["global", "composer", "completion", "overlay", "pager"] as const) {
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
