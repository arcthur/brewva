import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCommandPalettePayload,
  buildHelpHubPayload,
} from "../../../packages/brewva-cli/src/shell/commands/command-palette.js";
import { ShellCommandProvider } from "../../../packages/brewva-cli/src/shell/commands/command-provider.js";
import { registerShellCommands } from "../../../packages/brewva-cli/src/shell/commands/shell-command-registry.js";

describe("shell command provider", () => {
  test("derives palette, help, slash, and shortcut command surfaces independently", () => {
    const provider = new ShellCommandProvider();
    provider.register({
      id: "agent.model",
      title: "Switch model",
      description: "Select a model.",
      category: "Agent",
      slash: { name: "model", argumentMode: "optional" },
      shortcuts: ["ctrl+m"],
      suggested: true,
    });
    provider.register({
      id: "agent.connect",
      title: "Connect provider",
      description: "Connect a model provider.",
      category: "Agent",
      discovery: { help: false },
    });
    provider.register({
      id: "disabled.command",
      title: "Disabled command",
      category: "System",
      slash: { name: "disabled" },
      shortcuts: ["ctrl+d"],
      enabled: false,
    });

    expect(provider.paletteCommands()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "agent.connect",
          slashName: undefined,
        }),
        expect.objectContaining({
          id: "agent.model",
          slashName: "model",
          slashAliases: [],
          description: "Select a model.",
        }),
      ]),
    );
    expect(provider.helpCommands()).toMatchObject([
      {
        id: "agent.model",
        slashName: "model",
      },
    ]);
    expect(provider.slashCommands()).toMatchObject([
      {
        id: "agent.model",
        slashName: "model",
      },
    ]);
    expect(provider.keymapCommandBindings()).toMatchObject([
      {
        id: "agent.model",
        shortcuts: ["ctrl+m"],
        layer: "global",
      },
    ]);
  });

  test("search matches title, description, category, slash name, and slash aliases", () => {
    const provider = new ShellCommandProvider();
    provider.register({
      id: "operator.questions",
      title: "Inbox",
      description: "Open pending operator questions and shell notifications.",
      category: "Operator",
      slash: { name: "inbox" },
    });

    expect(provider.searchPaletteCommands("operator").map((command) => command.id)).toEqual([
      "operator.questions",
    ]);
    expect(provider.searchPaletteCommands("pending").map((command) => command.id)).toEqual([
      "operator.questions",
    ]);
    expect(provider.searchPaletteCommands("/inbox").map((command) => command.id)).toEqual([
      "operator.questions",
    ]);
    expect(provider.searchPaletteCommands("inbox").map((command) => command.id)).toEqual([
      "operator.questions",
    ]);
    expect(provider.searchPaletteCommands("opq").map((command) => command.id)).toEqual([
      "operator.questions",
    ]);
  });

  test("command palette suggestions render a visible section without row markers or descriptions", () => {
    const provider = new ShellCommandProvider();
    provider.register({
      id: "suggested.command",
      title: "Suggested command",
      description: "Appears first in an empty command palette.",
      category: "System",
      suggested: true,
    });
    provider.register({
      id: "regular.command",
      title: "Regular command",
      description: "Appears after suggested commands.",
      category: "System",
    });

    const payload = buildCommandPalettePayload({ commandProvider: provider });

    expect(payload.items.map((item) => ({ id: item.id, section: item.section }))).toEqual([
      { id: "suggested.command", section: "Suggested" },
      { id: "suggested.command", section: "System" },
      { id: "regular.command", section: "System" },
    ]);
    expect(payload.items.map((item) => item.marker)).toEqual([undefined, undefined, undefined]);
    expect(payload.items.map((item) => item.detail)).toEqual([undefined, undefined, undefined]);

    const filteredPayload = buildCommandPalettePayload({
      commandProvider: provider,
      query: "regular",
    });
    expect(filteredPayload.items.map((item) => ({ id: item.id, section: item.section }))).toEqual([
      { id: "regular.command", section: "System" },
    ]);
  });

  test("slash commands are listed in slash-name order", () => {
    const provider = new ShellCommandProvider();
    provider.register({
      id: "gamma",
      title: "Gamma title",
      category: "System",
      slash: { name: "zeta" },
      suggested: true,
    });
    provider.register({
      id: "alpha",
      title: "Alpha title",
      category: "Operator",
      slash: { name: "alpha" },
    });
    provider.register({
      id: "beta",
      title: "Beta title",
      category: "Agent",
      slash: { name: "beta" },
    });

    expect(provider.slashCommands().map((command) => command.slashName)).toEqual([
      "alpha",
      "beta",
      "zeta",
    ]);
  });

  test("fails fast on duplicate ids, slash names, and shortcuts", () => {
    const provider = new ShellCommandProvider();
    provider.register({
      id: "one",
      title: "One",
      category: "System",
      slash: { name: "one" },
      shortcuts: ["ctrl+k"],
    });

    expect(() =>
      provider.register({
        id: "one",
        title: "Duplicate id",
        category: "System",
      }),
    ).toThrow("Duplicate shell command id");
    expect(() =>
      provider.register({
        id: "two",
        title: "Duplicate slash",
        category: "System",
        slash: { name: "one" },
      }),
    ).toThrow("Duplicate shell command slash name");
    expect(() =>
      provider.register({
        id: "three",
        title: "Duplicate shortcut",
        category: "System",
        shortcuts: ["ctrl+k"],
      }),
    ).toThrow("Duplicate shell command shortcut");
  });

  test("supports hidden callable slash commands and explicit reserved names", () => {
    const provider = new ShellCommandProvider();
    provider.register({
      id: "legacy.hidden",
      title: "Legacy hidden command",
      category: "System",
      slash: { name: "legacy", visibility: "hidden" },
    });
    provider.reserveSlashNames([
      {
        name: "insights",
        owner: "runtime.insights",
        message: "/insights remains runtime-owned.",
      },
    ]);

    expect(provider.createSlashCommandIntent("legacy", { args: "", source: "slash" })).toEqual({
      type: "command.invoke",
      commandId: "legacy.hidden",
      args: "",
      source: "slash",
    });
    expect(provider.slashCommands()).toEqual([]);
    expect(provider.lookupSlashName("insights")).toEqual({
      kind: "reserved",
      reservation: {
        name: "insights",
        owner: "runtime.insights",
        message: "/insights remains runtime-owned.",
      },
    });
    expect(() =>
      provider.register({
        id: "runtime.shadow",
        title: "Shadow",
        category: "System",
        slash: { name: "insights" },
      }),
    ).toThrow("is reserved by runtime.insights");
  });

  test("palette-hidden commands still create command intents by id", () => {
    const provider = new ShellCommandProvider();
    provider.register({
      id: "hidden.internal",
      title: "Hidden internal",
      category: "System",
      discovery: { palette: false, help: false },
    });

    expect(provider.paletteCommands()).toEqual([]);
    expect(provider.helpCommands()).toEqual([]);
    expect(provider.createCommandIntent("hidden.internal")).toEqual({
      type: "command.invoke",
      commandId: "hidden.internal",
      args: "",
      source: "internal",
    });
  });

  test("disabled commands fail closed explicitly", () => {
    const provider = new ShellCommandProvider();
    provider.register({
      id: "runtime.insights",
      title: "Insights",
      category: "Runtime",
      slash: { name: "insights", argumentMode: "optional" },
      enabled: false,
    });
    provider.register({
      id: "disabled.command",
      title: "Disabled",
      category: "System",
      enabled: false,
    });

    expect(
      provider.createSlashCommandIntent("insights", {
        args: "src",
        source: "slash",
      }),
    ).toBe(undefined);
    expect(provider.createCommandIntent("disabled.command")).toBe(undefined);
  });

  test("built-in registry keeps palette-only commands out of slash and help surfaces", () => {
    const provider = new ShellCommandProvider();
    registerShellCommands(provider);

    expect(provider.createCommandIntent("app.commandPalette")).toEqual({
      type: "command.invoke",
      commandId: "app.commandPalette",
      args: "",
      source: "internal",
    });
    expect(provider.createSlashCommandIntent("connect", { args: "", source: "slash" })).toBe(
      undefined,
    );
    expect(provider.lookupSlashName("questions")).toMatchObject({
      kind: "reserved",
      reservation: {
        owner: "runtime.questions",
      },
    });
    expect(provider.slashCommands().map((command) => command.id)).toContain("agent.model");
    expect(provider.slashCommands().map((command) => command.id)).toContain("session.handoff");
    expect(provider.slashCommands().map((command) => command.id)).toContain("session.lineage");
    expect(provider.slashCommands().map((command) => command.id)).toContain("session.transcript");
    expect(provider.createSlashCommandIntent("lineage", { args: "", source: "slash" })).toEqual({
      type: "command.invoke",
      commandId: "session.lineage",
      args: "",
      source: "slash",
    });
    expect(
      provider.createSlashCommandIntent("handoff", { args: "ready for review", source: "slash" }),
    ).toEqual({
      type: "command.invoke",
      commandId: "session.handoff",
      args: "ready for review",
      source: "slash",
    });
    expect(provider.createSlashCommandIntent("transcript", { args: "", source: "slash" })).toEqual({
      type: "command.invoke",
      commandId: "session.transcript",
      args: "",
      source: "slash",
    });
    expect(provider.slashCommands().map((command) => command.id)).toContain("operator.inbox");
    expect(provider.helpCommands().map((command) => command.id)).toContain("session.transcript");
    expect(provider.helpCommands().map((command) => command.id)).not.toContain("agent.connect");
    expect(provider.helpCommands().map((command) => command.id)).not.toContain("session.queue");
    expect(provider.helpCommands().map((command) => command.id)).not.toContain("view.thinking");
    expect(provider.paletteCommands().map((command) => command.id)).toContain("session.queue");
    expect(provider.searchPaletteCommands("connect").map((command) => command.id)).toContain(
      "agent.connect",
    );
    expect(provider.keymapCommandBindings()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "agent.preset.next",
          shortcuts: ["shift+tab"],
        }),
      ]),
    );
    expect(provider.keymapCommandBindings().some((command) => command.id === "app.exit")).toBe(
      true,
    );
  });

  test("loads file-backed slash commands with fixed provider precedence and shadow diagnostics", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-shell-commands-project-"));
    const homeDir = mkdtempSync(join(tmpdir(), "brewva-shell-commands-home-"));
    const projectCommands = join(cwd, ".brewva", "commands");
    const userCommands = join(homeDir, ".brewva", "commands");
    mkdirSync(projectCommands, { recursive: true });
    mkdirSync(userCommands, { recursive: true });
    writeFileSync(
      join(projectCommands, "triage.md"),
      [
        "---",
        "description: Project triage",
        "arguments:",
        "  - name: topic",
        "    description: Topic to triage",
        "    required: true",
        "---",
        "Review {{topic}} with project context.",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(userCommands, "triage.md"),
      ["---", "description: User triage", "---", "User command should be shadowed."].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(projectCommands, "help.md"),
      [
        "---",
        "description: Shadow help",
        "---",
        "Project help should not replace built-in help.",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(projectCommands, "optional.md"),
      [
        "---",
        "description: Optional variables",
        "arguments:",
        "  - name: mode",
        "    description: Optional mode",
        "---",
        "Run in {{mode}} mode with {{missing}}.",
      ].join("\n"),
      "utf8",
    );

    const provider = new ShellCommandProvider();
    registerShellCommands(provider, { cwd, homeDir, loadFileCommands: true });

    expect(
      provider.createSlashCommandIntent("triage", {
        args: 'topic="cache \\"drift\\""',
        source: "slash",
      }),
    ).toEqual({
      type: "prompt.submit",
      source: "slash",
      text: 'Review cache "drift" with project context.',
    });
    expect(provider.createSlashCommandIntent("optional", { args: "", source: "slash" })).toEqual({
      type: "prompt.submit",
      source: "slash",
      text: "Run in  mode with .",
      warnings: ["Slash command /optional has missing optional template variables: missing, mode"],
    });
    expect(provider.createSlashCommandIntent("help", { args: "", source: "slash" })).toMatchObject({
      type: "command.invoke",
      commandId: "app.help",
    });

    expect(provider.slashCommands()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "file-command.brewva.project.triage",
          providerLabel: "Project Brewva",
          shadowedBy: undefined,
          path: join(projectCommands, "triage.md"),
        }),
        expect.objectContaining({
          id: "file-command.brewva.user.triage",
          providerLabel: "User Brewva",
          shadowedBy: "file-command.brewva.project.triage",
          path: join(userCommands, "triage.md"),
        }),
        expect.objectContaining({
          id: "file-command.brewva.project.help",
          shadowedBy: "app.help",
        }),
      ]),
    );
    const help = buildHelpHubPayload(provider);
    expect(help.lines.join("\n")).toContain(
      `Project Brewva · ${join(projectCommands, "triage.md")}`,
    );
    expect(help.lines.join("\n")).toContain("shadowed by file-command.brewva.project.triage");
  });

  test("file-backed slash commands fail closed when frontmatter requests authority", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-shell-commands-authority-"));
    const homeDir = mkdtempSync(join(tmpdir(), "brewva-shell-commands-authority-home-"));
    const commandRoot = join(cwd, ".claude", "commands");
    mkdirSync(commandRoot, { recursive: true });
    writeFileSync(
      join(commandRoot, "deploy.md"),
      ["---", "description: Deploy", "allowed-tools:", "  - Bash", "---", "Deploy now."].join("\n"),
      "utf8",
    );

    const provider = new ShellCommandProvider();

    expect(() => registerShellCommands(provider, { cwd, homeDir, loadFileCommands: true })).toThrow(
      "file-backed slash commands cannot request authority",
    );
  });

  test("built-in registry exposes the promoted interactive command surface", () => {
    const provider = new ShellCommandProvider();
    registerShellCommands(provider);

    const slashNames = provider.slashCommands().map((command) => command.slashName);
    expect(slashNames).toEqual(
      expect.arrayContaining([
        "context",
        "authority",
        "safety",
        "diff",
        "copy",
        "export",
        "skills",
        "init",
      ]),
    );

    for (const rejected of ["compact", "permissions", "review", "security-review"]) {
      expect(slashNames).not.toContain(rejected);
      expect(provider.lookupSlashName(rejected)).toMatchObject({ kind: "reserved" });
    }

    expect(provider.searchPaletteCommands("Context request compaction")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "context.requestCompaction",
          slashName: undefined,
        }),
      ]),
    );
    expect(provider.searchPaletteCommands("Transcript copy latest answer")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "transcript.copyLatestAnswer",
          slashName: undefined,
        }),
      ]),
    );
    expect(provider.searchPaletteCommands("Session export inspect bundle")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "session.exportInspectBundle",
          slashName: undefined,
        }),
      ]),
    );
    expect(provider.searchPaletteCommands("Diff export patch evidence")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "diff.exportPatchEvidence",
          slashName: undefined,
        }),
      ]),
    );

    expect(provider.lookupSlashName("compact")).toMatchObject({
      kind: "reserved",
      reservation: {
        message: expect.stringContaining("/context"),
        redirectCommandId: "session.context",
      },
    });
    expect(provider.lookupSlashName("permissions")).toMatchObject({
      kind: "reserved",
      reservation: {
        message: expect.stringContaining("/safety"),
        redirectCommandId: "operator.authority",
      },
    });
    expect(provider.lookupSlashName("review")).toMatchObject({
      kind: "reserved",
      reservation: {
        message: expect.stringContaining("/skills"),
        redirectCommandId: "skills.catalog",
      },
    });
  });
});
