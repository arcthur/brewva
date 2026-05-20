import type { CliShellOverlayPayload } from "../domain/overlays/payloads.js";
import type { ShellCommandListItem, ShellCommandProvider } from "./command-provider.js";

type CommandPalettePayload = Extract<CliShellOverlayPayload, { kind: "commandPalette" }>;
type HelpHubPayload = Extract<CliShellOverlayPayload, { kind: "helpHub" }>;
type ShortcutLabelLookup = (id: string) => string | undefined;

function commandShortcutLabel(
  command: ShellCommandListItem,
  lookup?: ShortcutLabelLookup,
): string | undefined {
  return lookup ? lookup(command.id) : command.shortcutLabel;
}

function keymapHint(lookup: ShortcutLabelLookup | undefined, id: string): string | undefined {
  return lookup?.(id);
}

function commandPaletteItem(
  command: ShellCommandListItem,
  input: { section?: string; shortcutLabel?: ShortcutLabelLookup } = {},
): CommandPalettePayload["items"][number] {
  const slash = command.slashName ? `/${command.slashName}` : undefined;
  const shortcut = commandShortcutLabel(command, input.shortcutLabel);
  return {
    id: command.id,
    section: input.section ?? command.category,
    label: command.title,
    footer: [slash, shortcut].filter(Boolean).join("  ") || undefined,
  };
}

export function buildCommandPalettePayload(input: {
  commandProvider: ShellCommandProvider;
  query?: string;
  selectedIndex?: number;
  shortcutLabel?: ShortcutLabelLookup;
}): CommandPalettePayload {
  const query = input.query ?? "";
  const commands = input.commandProvider.searchPaletteCommands(query);
  const baseItems = commands.map((command) =>
    commandPaletteItem(command, { shortcutLabel: input.shortcutLabel }),
  );
  const items = query.trim()
    ? baseItems
    : [
        ...commands
          .filter((command) => command.suggested)
          .map((command) =>
            commandPaletteItem(command, {
              section: "Suggested",
              shortcutLabel: input.shortcutLabel,
            }),
          ),
        ...baseItems,
      ];
  const run = keymapHint(input.shortcutLabel, "overlay.primary");
  const close = keymapHint(input.shortcutLabel, "overlay.close");
  const footer =
    [run ? `${run} run` : undefined, close ? `${close} close` : undefined, "type to search"]
      .filter(Boolean)
      .join(" · ") || undefined;
  return {
    kind: "commandPalette",
    title: "Commands",
    query,
    selectedIndex:
      items.length === 0 ? 0 : Math.max(0, Math.min(input.selectedIndex ?? 0, items.length - 1)),
    items,
    footer,
  };
}

export function buildHelpHubPayload(
  commandProvider: ShellCommandProvider,
  input: { shortcutLabel?: ShortcutLabelLookup } = {},
): HelpHubPayload {
  const visible = commandProvider.helpCommands();
  const grouped = new Map<string, ShellCommandListItem[]>();
  for (const command of visible) {
    const group = grouped.get(command.category) ?? [];
    group.push(command);
    grouped.set(command.category, group);
  }
  const paletteCommand = visible.find((command) => command.id === "app.commandPalette");
  const paletteShortcut = input.shortcutLabel
    ? input.shortcutLabel("app.commandPalette")
    : paletteCommand?.shortcutLabel;
  const overlayNext = keymapHint(input.shortcutLabel, "overlay.next");
  const overlayPrevious = keymapHint(input.shortcutLabel, "overlay.previous");
  const overlayPrimary = keymapHint(input.shortcutLabel, "overlay.primary");
  const overlayClose = keymapHint(input.shortcutLabel, "overlay.close");
  const lines = [
    "Brewva commands are searchable from the command palette.",
    paletteShortcut
      ? `${paletteShortcut} opens the command palette from any normal shell context.`
      : "The command palette is available from normal shell contexts.",
    "Type / in the composer for slash commands; advanced controls stay in the palette.",
    "",
    "Navigation",
    [
      overlayNext && overlayPrevious
        ? `${overlayPrevious}/${overlayNext} move selection`
        : undefined,
      overlayPrimary ? `${overlayPrimary} runs` : undefined,
      overlayClose ? `${overlayClose} closes` : undefined,
    ]
      .filter(Boolean)
      .join("; "),
    "",
    "Commands",
  ];
  for (const [category, commands] of [...grouped.entries()].toSorted((left, right) =>
    left[0].localeCompare(right[0]),
  )) {
    lines.push("", category);
    for (const command of commands) {
      const slash = command.slashName ? `/${command.slashName}` : "";
      const suffix = [slash, commandShortcutLabel(command, input.shortcutLabel) ?? ""]
        .filter(Boolean)
        .join(" · ");
      lines.push(`  ${command.title}${suffix ? ` (${suffix})` : ""}`);
    }
  }
  const footer =
    [
      overlayPrimary ? `${overlayPrimary} close` : undefined,
      overlayClose ? `${overlayClose} close` : undefined,
    ]
      .filter(Boolean)
      .join(" · ") || undefined;
  return {
    kind: "helpHub",
    title: "Help",
    lines,
    footer,
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
