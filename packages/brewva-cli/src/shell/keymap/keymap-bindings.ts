import { normalizeShellInputTrigger, type ShellInputTrigger } from "../domain/keymap.js";
import type {
  BrewvaKeymapBindingDefinition,
  BrewvaKeymapLayer,
  BrewvaResolvedKeymapBindings,
  BrewvaShortcutValue,
} from "../domain/tui.js";

export type {
  BrewvaKeymapBindingDefinition,
  BrewvaKeymapLayer,
  BrewvaResolvedKeymapBindings,
  BrewvaShortcutValue,
};

export interface BrewvaKeymapBindingBuildInput {
  readonly commandBindings?: readonly BrewvaKeymapBindingDefinition[];
  readonly overrides?: Readonly<Record<string, BrewvaShortcutValue>>;
}

export const BREWVA_KEY_ALIASES = {
  enter: "return",
  esc: "escape",
  pgdown: "pagedown",
  pgup: "pageup",
} as const;

const KEY_LABELS: Readonly<Record<string, string>> = {
  backspace: "Backspace",
  delete: "Del",
  down: "Down",
  end: "End",
  escape: "Esc",
  home: "Home",
  left: "Left",
  pagedown: "PgDn",
  pageup: "PgUp",
  return: "Enter",
  right: "Right",
  space: "Space",
  tab: "Tab",
  up: "Up",
};

const MODIFIER_LABELS: Readonly<Record<string, string>> = {
  ctrl: "Ctrl",
  hyper: "Hyper",
  leader: "Leader",
  meta: "Alt",
  shift: "Shift",
  super: "Super",
};

export const BREWVA_EFFECT_KEYMAP_BINDINGS: readonly BrewvaKeymapBindingDefinition[] = [
  {
    id: "app.shortcutOverlay",
    title: "Shortcut overlay",
    category: "System",
    layer: "global",
    shortcuts: ["leader ?"],
    effect: { type: "overlay.openShortcutOverlay" },
    internal: true,
  },
  {
    id: "composer.submit",
    title: "Submit prompt",
    category: "Composer",
    layer: "composer",
    shortcuts: ["return"],
    effect: { type: "composer.submit" },
    internal: true,
  },
  {
    id: "composer.newline",
    title: "Insert newline",
    category: "Composer",
    layer: "composer",
    shortcuts: ["ctrl+j"],
    effect: { type: "composer.insertNewline" },
    internal: true,
  },
  {
    id: "completion.accept",
    title: "Accept completion",
    category: "Completion",
    layer: "completion",
    shortcuts: ["tab"],
    effect: { type: "completion.accept" },
    internal: true,
  },
  {
    id: "completion.submit",
    title: "Submit completion",
    category: "Completion",
    layer: "completion",
    shortcuts: ["return"],
    effect: { type: "completion.submit" },
    internal: true,
  },
  {
    id: "completion.next",
    title: "Next completion",
    category: "Completion",
    layer: "completion",
    shortcuts: ["down", "ctrl+n"],
    effect: { type: "completion.move", delta: 1 },
    internal: true,
  },
  {
    id: "completion.previous",
    title: "Previous completion",
    category: "Completion",
    layer: "completion",
    shortcuts: ["up", "ctrl+p"],
    effect: { type: "completion.move", delta: -1 },
    internal: true,
  },
  {
    id: "completion.dismiss",
    title: "Dismiss completion",
    category: "Completion",
    layer: "completion",
    shortcuts: ["escape"],
    effect: { type: "completion.dismiss" },
    internal: true,
  },
  {
    id: "overlay.close",
    title: "Close overlay",
    category: "Overlay",
    layer: "overlay",
    shortcuts: ["escape"],
    effect: { type: "overlay.closeActive", cancelled: true },
    internal: true,
  },
  {
    id: "overlay.primary",
    title: "Run overlay primary action",
    category: "Overlay",
    layer: "overlay",
    shortcuts: ["return"],
    effect: { type: "overlay.primary" },
    internal: true,
  },
  {
    id: "overlay.next",
    title: "Next overlay item",
    category: "Overlay",
    layer: "overlay",
    shortcuts: ["down", "ctrl+n"],
    effect: { type: "overlay.moveSelection", delta: 1 },
    internal: true,
  },
  {
    id: "overlay.previous",
    title: "Previous overlay item",
    category: "Overlay",
    layer: "overlay",
    shortcuts: ["up", "ctrl+p"],
    effect: { type: "overlay.moveSelection", delta: -1 },
    internal: true,
  },
  {
    id: "overlay.pageDown",
    title: "Page overlay down",
    category: "Overlay",
    layer: "overlay",
    shortcuts: ["pagedown"],
    effect: { type: "overlay.scrollPage", direction: 1 },
    internal: true,
  },
  {
    id: "overlay.pageUp",
    title: "Page overlay up",
    category: "Overlay",
    layer: "overlay",
    shortcuts: ["pageup"],
    effect: { type: "overlay.scrollPage", direction: -1 },
    internal: true,
  },
  {
    id: "overlay.fullscreen",
    title: "Toggle overlay fullscreen",
    category: "Overlay",
    layer: "overlay",
    shortcuts: ["ctrl+f"],
    effect: { type: "overlay.toggleFullscreen" },
    internal: true,
  },
  {
    id: "pager.external",
    title: "Open pager externally",
    category: "Overlay",
    layer: "overlay",
    shortcuts: ["ctrl+e"],
    effect: { type: "pager.externalActive" },
    internal: true,
  },
  {
    id: "selection.copy",
    title: "Copy selection",
    category: "Selection",
    layer: "selection",
    shortcuts: ["ctrl+c"],
    internal: true,
  },
  {
    id: "selection.clear",
    title: "Clear selection",
    category: "Selection",
    layer: "selection",
    shortcuts: ["escape"],
    internal: true,
  },
  {
    id: "transcript.pageUp",
    title: "Page transcript up",
    category: "Transcript",
    layer: "global",
    shortcuts: ["pageup"],
    effect: { type: "transcript.navigate", kind: "pageUp" },
    internal: true,
  },
  {
    id: "transcript.pageDown",
    title: "Page transcript down",
    category: "Transcript",
    layer: "global",
    shortcuts: ["pagedown"],
    effect: { type: "transcript.navigate", kind: "pageDown" },
    internal: true,
  },
  {
    id: "transcript.top",
    title: "Jump transcript to top",
    category: "Transcript",
    layer: "global",
    shortcuts: ["home"],
    effect: { type: "transcript.navigate", kind: "top" },
    internal: true,
  },
  {
    id: "transcript.bottom",
    title: "Jump transcript to bottom",
    category: "Transcript",
    layer: "global",
    shortcuts: ["end"],
    effect: { type: "transcript.navigate", kind: "bottom" },
    internal: true,
  },
  {
    id: "subagentFooter.toggle",
    title: "Toggle subagent footer",
    category: "Subagents",
    layer: "global",
    shortcuts: ["leader b"],
    effect: { type: "subagentFooter.toggle" },
    internal: true,
  },
  {
    id: "subagentFooter.close",
    title: "Close subagent footer",
    category: "Subagents",
    layer: "subagentFooter",
    shortcuts: ["escape"],
    effect: { type: "subagentFooter.close" },
    internal: true,
  },
  {
    id: "subagentFooter.next",
    title: "Next subagent",
    category: "Subagents",
    layer: "subagentFooter",
    shortcuts: ["tab", "down", "ctrl+n"],
    effect: { type: "subagentFooter.selectRelative", delta: 1 },
    internal: true,
  },
  {
    id: "subagentFooter.previous",
    title: "Previous subagent",
    category: "Subagents",
    layer: "subagentFooter",
    shortcuts: ["shift+tab", "up", "ctrl+p"],
    effect: { type: "subagentFooter.selectRelative", delta: -1 },
    internal: true,
  },
  {
    id: "subagentFooter.pageDown",
    title: "Scroll subagent detail down",
    category: "Subagents",
    layer: "subagentFooter",
    shortcuts: ["pagedown", "j"],
    effect: { type: "subagentFooter.scroll", delta: 6 },
    internal: true,
  },
  {
    id: "subagentFooter.pageUp",
    title: "Scroll subagent detail up",
    category: "Subagents",
    layer: "subagentFooter",
    shortcuts: ["pageup", "k"],
    effect: { type: "subagentFooter.scroll", delta: -6 },
    internal: true,
  },
  {
    id: "subagentFooter.openSession",
    title: "Open selected subagent session",
    category: "Subagents",
    layer: "subagentFooter",
    shortcuts: ["return"],
    effect: { type: "subagentFooter.openSelectedSession" },
    internal: true,
  },
  {
    id: "subagentFooter.cancel",
    title: "Cancel selected subagent",
    category: "Subagents",
    layer: "subagentFooter",
    shortcuts: ["c"],
    effect: { type: "subagentFooter.cancelSelected" },
    internal: true,
  },
];

export const BREWVA_BUILT_IN_KEYMAP_BINDINGS: readonly BrewvaKeymapBindingDefinition[] = [
  ...BREWVA_EFFECT_KEYMAP_BINDINGS,
];

function expandShortcutAlias(token: string): string {
  return BREWVA_KEY_ALIASES[token as keyof typeof BREWVA_KEY_ALIASES] ?? token;
}

function normalizeShortcutChord(chord: string): string {
  return chord
    .split("+")
    .map((part) => expandShortcutAlias(part.trim().toLowerCase()))
    .filter(Boolean)
    .join("+");
}

export function normalizeShortcutSequence(sequence: string): string {
  return sequence.trim().split(/\s+/u).map(normalizeShortcutChord).filter(Boolean).join(" ");
}

export function shortcutSequenceFromShellInputTrigger(trigger: ShellInputTrigger): string {
  const normalized = normalizeShellInputTrigger(trigger);
  const parts = [
    normalized.ctrl ? "ctrl" : "",
    normalized.meta ? "meta" : "",
    normalized.shift ? "shift" : "",
    expandShortcutAlias(normalized.key),
  ].filter(Boolean);
  return normalizeShortcutSequence(parts.join("+"));
}

function normalizeShortcutValue(value: BrewvaShortcutValue): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "none") {
    return [];
  }
  const raw: readonly string[] = typeof value === "string" ? value.split(",") : [...value];
  return [...new Set(raw.map(normalizeShortcutSequence).filter(Boolean))];
}

function normalizeDefinitions(
  definitions: readonly BrewvaKeymapBindingDefinition[],
  overrides: Readonly<Record<string, BrewvaShortcutValue>>,
): BrewvaKeymapBindingDefinition[] {
  const byId = new Map<string, BrewvaKeymapBindingDefinition>();
  for (const definition of definitions) {
    if (byId.has(definition.id)) {
      throw new Error(`Duplicate Brewva TUI binding id: ${definition.id}`);
    }
    const override = normalizeShortcutValue(overrides[definition.id]);
    byId.set(definition.id, {
      ...definition,
      shortcuts: override ?? definition.shortcuts.map(normalizeShortcutSequence),
    });
  }

  for (const id of Object.keys(overrides)) {
    if (!byId.has(id)) {
      continue;
    }
    const value = normalizeShortcutValue(overrides[id]);
    if (value !== undefined) {
      byId.set(id, { ...byId.get(id)!, shortcuts: value });
    }
  }

  const ownerByShortcut = new Map<string, string>();
  for (const definition of byId.values()) {
    for (const shortcut of definition.shortcuts) {
      const scopedShortcut = `${definition.layer ?? "global"}:${shortcut}`;
      const existing = ownerByShortcut.get(scopedShortcut);
      if (existing && existing !== definition.id) {
        throw new Error(
          `Duplicate Brewva TUI shortcut '${shortcut}' for ${definition.id}; already used by ${existing}`,
        );
      }
      ownerByShortcut.set(scopedShortcut, definition.id);
    }
  }
  return [...byId.values()];
}

export function buildBrewvaKeymapBindings(
  input: BrewvaKeymapBindingBuildInput = {},
): BrewvaResolvedKeymapBindings {
  const bindingDefinitions = [...(input.commandBindings ?? []), ...BREWVA_EFFECT_KEYMAP_BINDINGS];
  const definitions = normalizeDefinitions(bindingDefinitions, input.overrides ?? {});
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  return {
    definitions,
    get(id) {
      return byId.get(id)?.shortcuts ?? [];
    },
    getDefinition(id) {
      return byId.get(id);
    },
    ids() {
      return [...byId.keys()];
    },
    has(id) {
      return byId.has(id);
    },
  };
}

function formatShortcutToken(token: string): string {
  const label = KEY_LABELS[token] ?? MODIFIER_LABELS[token];
  if (label) {
    return label;
  }
  return token.length === 1 ? token.toUpperCase() : token;
}

export function formatShortcutLabel(shortcut: string | undefined): string | undefined {
  if (!shortcut) {
    return undefined;
  }
  return normalizeShortcutSequence(shortcut)
    .split(/\s+/u)
    .map((chord) => chord.split("+").map(formatShortcutToken).join("+"))
    .join(" ");
}

export function formatShortcutLabels(shortcuts: readonly string[]): string | undefined {
  const labels = shortcuts
    .map(formatShortcutLabel)
    .filter((label): label is string => Boolean(label));
  return labels.length > 0 ? labels.join(", ") : undefined;
}

export function buildShortcutOverlayLines(bindings: BrewvaResolvedKeymapBindings): string[] {
  const visible = bindings.definitions
    .filter((definition) => definition.shortcuts.length > 0)
    .toSorted(
      (left, right) =>
        left.category.localeCompare(right.category) ||
        left.title.localeCompare(right.title) ||
        left.id.localeCompare(right.id),
    );
  const lines = ["Brewva shortcuts are resolved from the active TUI keymap.", ""];
  let currentCategory = "";
  for (const definition of visible) {
    if (definition.category !== currentCategory) {
      currentCategory = definition.category;
      lines.push(currentCategory);
    }
    lines.push(
      `  ${definition.title} (${formatShortcutLabels(definition.shortcuts) ?? definition.id})`,
    );
  }
  return lines;
}

export function pickShortcutLabel(
  bindings: BrewvaResolvedKeymapBindings,
  id: string,
): string | undefined {
  return formatShortcutLabel(bindings.get(id)[0]);
}
