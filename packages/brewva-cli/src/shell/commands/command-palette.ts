import type { CliShellOverlayPayload } from "../domain/overlays/payloads.js";
import {
  formatKeybindingLabel,
  type ShellCommandListItem,
  type ShellCommandProvider,
} from "./command-provider.js";

type CommandPalettePayload = Extract<CliShellOverlayPayload, { kind: "commandPalette" }>;
type HelpHubPayload = Extract<CliShellOverlayPayload, { kind: "helpHub" }>;

function commandPaletteItem(
  command: ShellCommandListItem,
  input: { section?: string } = {},
): CommandPalettePayload["items"][number] {
  const slash = command.slashName ? `/${command.slashName}` : undefined;
  const keybinding = formatKeybindingLabel(command.keybinding);
  return {
    id: command.id,
    section: input.section ?? command.category,
    label: command.title,
    footer: [slash, keybinding].filter(Boolean).join("  ") || undefined,
  };
}

export function buildCommandPalettePayload(input: {
  commandProvider: ShellCommandProvider;
  query?: string;
  selectedIndex?: number;
}): CommandPalettePayload {
  const query = input.query ?? "";
  const commands = input.commandProvider.searchPaletteCommands(query);
  const baseItems = commands.map((command) => commandPaletteItem(command));
  const items = query.trim()
    ? baseItems
    : [
        ...commands
          .filter((command) => command.suggested)
          .map((command) => commandPaletteItem(command, { section: "Suggested" })),
        ...baseItems,
      ];
  return {
    kind: "commandPalette",
    title: "Commands",
    query,
    selectedIndex:
      items.length === 0 ? 0 : Math.max(0, Math.min(input.selectedIndex ?? 0, items.length - 1)),
    items,
  };
}

export function buildHelpHubPayload(commandProvider: ShellCommandProvider): HelpHubPayload {
  const visible = commandProvider.helpCommands();
  const grouped = new Map<string, ShellCommandListItem[]>();
  for (const command of visible) {
    const group = grouped.get(command.category) ?? [];
    group.push(command);
    grouped.set(command.category, group);
  }
  const lines = [
    "Brewva commands are searchable from the command palette.",
    "Ctrl+K opens the command palette from any normal shell context.",
    "Type / in the composer for slash commands; advanced controls stay in the palette.",
    "",
    "Navigation",
    "↑/↓ or Ctrl+P/Ctrl+N move selection; Enter runs; Esc closes.",
    "",
    "Commands",
  ];
  for (const [category, commands] of [...grouped.entries()].toSorted((left, right) =>
    left[0].localeCompare(right[0]),
  )) {
    lines.push("", category);
    for (const command of commands) {
      const slash = command.slashName ? `/${command.slashName}` : "";
      const keybinding = formatKeybindingLabel(command.keybinding) ?? "";
      const suffix = [slash, keybinding].filter(Boolean).join(" · ");
      lines.push(`  ${command.title}${suffix ? ` (${suffix})` : ""}`);
    }
  }
  return {
    kind: "helpHub",
    title: "Help",
    lines,
  };
}

export function parseShellSlashPrompt(prompt: string): { name: string; args: string } | undefined {
  const match = /^\/(?<name>[^\s]+)(?:\s+(?<args>[\s\S]*))?$/u.exec(prompt);
  const name = match?.groups?.name;
  if (!name) {
    return undefined;
  }
  return {
    name,
    args: match.groups?.args ?? "",
  };
}
