import type { KeybindingDefinition, KeybindingTrigger } from "@brewva/brewva-tui";
import { fuzzyScore, normalizeSearchQuery } from "./search-scoring.js";
import type { SlashCommandEntry } from "./types.js";

export interface ShellCommandRunInput {
  readonly args: string;
  readonly source: "keybinding" | "palette" | "slash" | "internal";
}

export type ShellCommandRunner = (
  input: ShellCommandRunInput,
) => boolean | void | Promise<boolean | void>;

export interface ShellCommand {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly category: string;
  readonly slash?: {
    readonly name: string;
    readonly aliases?: readonly string[];
    readonly argumentMode?: "none" | "optional" | "required";
  };
  readonly keybinding?: KeybindingTrigger;
  readonly hidden?: boolean;
  readonly enabled?: boolean;
  readonly suggested?: boolean;
  readonly run: ShellCommandRunner;
}

export interface ShellCommandListItem {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly category: string;
  readonly slashName?: string;
  readonly slashAliases: readonly string[];
  readonly keybinding?: KeybindingTrigger;
  readonly suggested: boolean;
}

function keybindingIdentity(trigger: KeybindingTrigger): string {
  return [
    trigger.ctrl ? "ctrl" : "",
    trigger.meta ? "meta" : "",
    trigger.shift ? "shift" : "",
    trigger.key,
  ]
    .filter(Boolean)
    .join("+");
}

export function formatKeybindingLabel(trigger: KeybindingTrigger | undefined): string | undefined {
  if (!trigger) {
    return undefined;
  }
  return [
    trigger.ctrl ? "Ctrl" : "",
    trigger.meta ? "Meta" : "",
    trigger.shift ? "Shift" : "",
    trigger.key.length === 1 ? trigger.key.toUpperCase() : trigger.key,
  ]
    .filter(Boolean)
    .join("+");
}

function takeBetterScore(current: number | null, next: number | null): number | null {
  if (next === null) {
    return current;
  }
  return current === null ? next : Math.max(current, next);
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
  readonly #keybindings = new Map<string, string>();

  register(command: ShellCommand): void {
    if (this.#commands.has(command.id)) {
      throw new Error(`Duplicate shell command id: ${command.id}`);
    }
    if (command.slash) {
      const names = [command.slash.name, ...(command.slash.aliases ?? [])];
      for (const name of names) {
        const normalized = name.toLowerCase();
        const existing = this.#slashNames.get(normalized);
        if (existing) {
          throw new Error(
            `Duplicate shell command slash name '${name}' for ${command.id}; already used by ${existing}`,
          );
        }
        this.#slashNames.set(normalized, command.id);
      }
    }
    if (command.keybinding) {
      const identity = keybindingIdentity(command.keybinding);
      const existing = this.#keybindings.get(identity);
      if (existing) {
        throw new Error(
          `Duplicate shell command keybinding '${identity}' for ${command.id}; already used by ${existing}`,
        );
      }
      this.#keybindings.set(identity, command.id);
    }
    this.#commands.set(command.id, command);
  }

  visibleCommands(): ShellCommandListItem[] {
    return [...this.#commands.values()]
      .filter((command) => command.enabled !== false && command.hidden !== true)
      .map((command) => this.toListItem(command))
      .toSorted(
        (left, right) =>
          Number(right.suggested) - Number(left.suggested) ||
          left.category.localeCompare(right.category) ||
          left.title.localeCompare(right.title),
      );
  }

  slashCommands(): SlashCommandEntry[] {
    return this.visibleCommands()
      .filter((command) => command.slashName)
      .map((command) => {
        const source = this.#commands.get(command.id);
        return {
          command: command.slashName ?? command.id,
          aliases: command.slashAliases,
          description: command.description ?? command.title,
          argumentMode: source?.slash?.argumentMode ?? "none",
        };
      });
  }

  keyboundCommands(): KeybindingDefinition[] {
    return [...this.#commands.values()]
      .filter((command) => command.keybinding && command.enabled !== false)
      .map((command) => ({
        id: `command.${command.id}`,
        context: "global",
        trigger: command.keybinding as KeybindingTrigger,
        action: `command:${command.id}`,
      }));
  }

  searchCommands(query: string): ShellCommandListItem[] {
    return this.visibleCommands()
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

  async runCommand(
    id: string,
    input: ShellCommandRunInput = { args: "", source: "internal" },
  ): Promise<boolean> {
    const command = this.#commands.get(id);
    if (!command) {
      return false;
    }
    const result = await command.run(input);
    return result !== false;
  }

  resolveSlashCommand(name: string): ShellCommand | undefined {
    const id = this.#slashNames.get(name.toLowerCase());
    return id ? this.#commands.get(id) : undefined;
  }

  getCommand(id: string): ShellCommand | undefined {
    return this.#commands.get(id);
  }

  private toListItem(command: ShellCommand): ShellCommandListItem {
    return {
      id: command.id,
      title: command.title,
      description: command.description,
      category: command.category,
      slashName: command.slash?.name,
      slashAliases: command.slash?.aliases ?? [],
      keybinding: command.keybinding,
      suggested: command.suggested === true,
    };
  }
}
