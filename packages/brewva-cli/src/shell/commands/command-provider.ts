import type { ShellIntent } from "../domain/intent.js";
import { fuzzyScore, normalizeSearchQuery } from "../domain/search-scoring.js";
import {
  formatShortcutLabels,
  normalizeShortcutSequence,
  type BrewvaKeymapBindingDefinition,
} from "../keymap/keymap-bindings.js";

export interface ShellCommandRunInput {
  readonly args: string;
  readonly source: "keybinding" | "palette" | "slash" | "internal";
}

export type ShellCommandIntentFactory = (input: ShellCommandRunInput) => ShellIntent | undefined;

export interface ShellSlashMetadata {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly argumentMode?: "none" | "optional" | "required";
  readonly visibility?: "visible" | "hidden";
}

export interface ShellSlashReservation {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly owner: string;
  readonly message?: string;
  readonly redirectCommandId?: string;
}

export interface ShellCommand {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly category: string;
  readonly discovery?: {
    readonly palette?: boolean;
    readonly help?: boolean;
  };
  readonly slash?: ShellSlashMetadata;
  readonly shortcuts?: readonly string[];
  readonly enabled?: boolean;
  readonly suggested?: boolean;
  readonly createIntent?: ShellCommandIntentFactory;
}

export interface ShellCommandListItem {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly category: string;
  readonly slashName?: string;
  readonly slashAliases: readonly string[];
  readonly shortcuts: readonly string[];
  readonly shortcutLabel?: string;
  readonly suggested: boolean;
}

function takeBetterScore(current: number | null, next: number | null): number | null {
  if (next === null) {
    return current;
  }
  return current === null ? next : Math.max(current, next);
}

type ShellSlashCommandListItem = ShellCommandListItem & {
  readonly slashName: string;
};

function compareSlashCommandItems(
  left: ShellSlashCommandListItem,
  right: ShellSlashCommandListItem,
): number {
  return (
    left.slashName.localeCompare(right.slashName) ||
    left.title.localeCompare(right.title) ||
    left.id.localeCompare(right.id)
  );
}

function commandSearchScore(command: ShellCommandListItem, query: string): number | null {
  const normalized = normalizeSearchQuery(query);
  if (!normalized) {
    return command.suggested ? 1_000 : 0;
  }

  let best = takeBetterScore(null, fuzzyScore(normalized, command.title));
  if (command.slashName) {
    best = takeBetterScore(best, fuzzyScore(normalized, command.slashName));
  }
  for (const alias of command.slashAliases) {
    best = takeBetterScore(best, fuzzyScore(normalized, alias));
  }
  const categoryScore = fuzzyScore(normalized, command.category);
  best = takeBetterScore(best, categoryScore === null ? null : categoryScore - 250);
  const descriptionScore = fuzzyScore(normalized, command.description ?? "");
  best = takeBetterScore(best, descriptionScore === null ? null : descriptionScore - 500);
  return best;
}

export class ShellCommandProvider {
  readonly #commands = new Map<string, ShellCommand>();
  readonly #slashNames = new Map<string, string>();
  readonly #reservedSlashNames = new Map<string, ShellSlashReservation>();
  readonly #shortcuts = new Map<string, string>();

  static #isEnabled(command: ShellCommand): boolean {
    return command.enabled !== false;
  }

  static #isPaletteVisible(command: ShellCommand): boolean {
    return ShellCommandProvider.#isEnabled(command) && command.discovery?.palette !== false;
  }

  static #isHelpVisible(command: ShellCommand): boolean {
    if (!ShellCommandProvider.#isEnabled(command)) {
      return false;
    }
    if (typeof command.discovery?.help === "boolean") {
      return command.discovery.help;
    }
    return ShellCommandProvider.#isPaletteVisible(command);
  }

  static #isSlashCallable(command: ShellCommand): boolean {
    return ShellCommandProvider.#isEnabled(command) && command.slash !== undefined;
  }

  static #isSlashVisible(command: ShellCommand): boolean {
    return ShellCommandProvider.#isSlashCallable(command) && command.slash?.visibility !== "hidden";
  }

  register(command: ShellCommand): void {
    if (this.#commands.has(command.id)) {
      throw new Error(`Duplicate shell command id: ${command.id}`);
    }
    if (ShellCommandProvider.#isSlashCallable(command)) {
      const slash = command.slash;
      if (!slash) {
        throw new Error(`Slash-callable shell command ${command.id} is missing slash metadata`);
      }
      const names = [slash.name, ...(slash.aliases ?? [])];
      for (const name of names) {
        const normalized = name.toLowerCase();
        const reservation = this.#reservedSlashNames.get(normalized);
        if (reservation) {
          throw new Error(
            `Slash name '${name}' for ${command.id} is reserved by ${reservation.owner}`,
          );
        }
        const existing = this.#slashNames.get(normalized);
        if (existing) {
          throw new Error(
            `Duplicate shell command slash name '${name}' for ${command.id}; already used by ${existing}`,
          );
        }
        this.#slashNames.set(normalized, command.id);
      }
    }
    for (const shortcut of command.shortcuts ?? []) {
      const identity = normalizeShortcutSequence(shortcut);
      const existing = this.#shortcuts.get(identity);
      if (existing) {
        throw new Error(
          `Duplicate shell command shortcut '${identity}' for ${command.id}; already used by ${existing}`,
        );
      }
      this.#shortcuts.set(identity, command.id);
    }
    this.#commands.set(command.id, command);
  }

  reserveSlashNames(reservations: readonly ShellSlashReservation[]): void {
    for (const reservation of reservations) {
      const names = [reservation.name, ...(reservation.aliases ?? [])];
      for (const name of names) {
        const normalized = name.toLowerCase();
        const existingCommand = this.#slashNames.get(normalized);
        if (existingCommand) {
          throw new Error(
            `Reserved slash name '${name}' for ${reservation.owner}; already used by ${existingCommand}`,
          );
        }
        const existingReservation = this.#reservedSlashNames.get(normalized);
        if (existingReservation) {
          throw new Error(
            `Reserved slash name '${name}' for ${reservation.owner}; already reserved by ${existingReservation.owner}`,
          );
        }
        this.#reservedSlashNames.set(normalized, reservation);
      }
    }
  }

  paletteCommands(): ShellCommandListItem[] {
    return [...this.#commands.values()]
      .filter((command) => ShellCommandProvider.#isPaletteVisible(command))
      .map((command) => this.toListItem(command))
      .toSorted(
        (left, right) =>
          Number(right.suggested) - Number(left.suggested) ||
          left.category.localeCompare(right.category) ||
          left.title.localeCompare(right.title),
      );
  }

  helpCommands(): ShellCommandListItem[] {
    return [...this.#commands.values()]
      .filter((command) => ShellCommandProvider.#isHelpVisible(command))
      .map((command) => this.toListItem(command))
      .toSorted(
        (left, right) =>
          Number(right.suggested) - Number(left.suggested) ||
          left.category.localeCompare(right.category) ||
          left.title.localeCompare(right.title),
      );
  }

  slashCommands(): ShellCommandListItem[] {
    return [...this.#commands.values()]
      .filter((command) => ShellCommandProvider.#isSlashVisible(command))
      .map((command): ShellSlashCommandListItem => {
        const item = this.toListItem(command);
        if (!item.slashName) {
          throw new Error(`Slash-visible shell command ${command.id} is missing a slash name`);
        }
        return {
          id: item.id,
          title: item.title,
          description: item.description,
          category: item.category,
          slashName: item.slashName,
          slashAliases: item.slashAliases,
          shortcuts: item.shortcuts,
          shortcutLabel: item.shortcutLabel,
          suggested: item.suggested,
        };
      })
      .toSorted(compareSlashCommandItems);
  }

  keymapCommandBindings(): BrewvaKeymapBindingDefinition[] {
    return [...this.#commands.values()]
      .filter((command) => command.shortcuts && ShellCommandProvider.#isEnabled(command))
      .map((command) => ({
        id: command.id,
        title: command.title,
        category: command.category,
        layer: "global",
        shortcuts: command.shortcuts?.map(normalizeShortcutSequence) ?? [],
      }));
  }

  searchPaletteCommands(query: string): ShellCommandListItem[] {
    return this.paletteCommands()
      .map((command) => ({
        command,
        score: commandSearchScore(command, query),
      }))
      .filter((entry): entry is { command: ShellCommandListItem; score: number } => {
        return entry.score !== null;
      })
      .toSorted(
        (left, right) =>
          right.score - left.score ||
          Number(right.command.suggested) - Number(left.command.suggested) ||
          left.command.category.localeCompare(right.command.category) ||
          left.command.title.localeCompare(right.command.title),
      )
      .map((entry) => entry.command);
  }

  createCommandIntent(
    id: string,
    input: ShellCommandRunInput = { args: "", source: "internal" },
  ): ShellIntent | undefined {
    const command = this.#commands.get(id);
    if (!command || command.enabled === false) {
      return undefined;
    }
    if (command.createIntent) {
      return command.createIntent(input);
    }
    return {
      type: "command.invoke",
      commandId: command.id,
      args: input.args,
      source: input.source,
    };
  }

  createSlashCommandIntent(name: string, input: ShellCommandRunInput): ShellIntent | undefined {
    const command = this.resolveSlashCommand(name);
    return command ? this.createCommandIntent(command.id, input) : undefined;
  }

  lookupSlashName(
    name: string,
  ):
    | { kind: "command"; command: ShellCommand }
    | { kind: "reserved"; reservation: ShellSlashReservation }
    | undefined {
    const normalized = name.toLowerCase();
    const id = this.#slashNames.get(normalized);
    if (id) {
      const command = this.#commands.get(id);
      if (command) {
        return { kind: "command", command };
      }
    }
    const reservation = this.#reservedSlashNames.get(normalized);
    return reservation ? { kind: "reserved", reservation } : undefined;
  }

  resolveSlashCommand(name: string): ShellCommand | undefined {
    const match = this.lookupSlashName(name);
    return match?.kind === "command" ? match.command : undefined;
  }

  getCommand(id: string): ShellCommand | undefined {
    return this.#commands.get(id);
  }

  private toListItem(command: ShellCommand): ShellCommandListItem {
    const slash = ShellCommandProvider.#isSlashVisible(command) ? command.slash : undefined;
    return {
      id: command.id,
      title: command.title,
      description: command.description,
      category: command.category,
      slashName: slash?.name,
      slashAliases: slash?.aliases ?? [],
      shortcuts: command.shortcuts?.map(normalizeShortcutSequence) ?? [],
      shortcutLabel: formatShortcutLabels(command.shortcuts ?? []),
      suggested: command.suggested === true,
    };
  }
}
