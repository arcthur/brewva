import { describe, expect, test } from "bun:test";
import { ShellCommandProvider } from "../../../packages/brewva-cli/src/shell/commands/command-provider.js";
import { registerShellCommands } from "../../../packages/brewva-cli/src/shell/commands/shell-command-registry.js";

describe("shell command provider", () => {
  test("derives palette, help, slash, and keybound command surfaces independently", () => {
    const provider = new ShellCommandProvider();
    provider.register({
      id: "agent.model",
      title: "Switch model",
      description: "Select a model.",
      category: "Agent",
      slash: { name: "model", argumentMode: "optional" },
      keybinding: { key: "m", ctrl: true, meta: false, shift: false },
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
      keybinding: { key: "d", ctrl: true, meta: false, shift: false },
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
    expect(provider.keyboundCommands()).toMatchObject([
      {
        id: "command.agent.model",
        action: "command:agent.model",
        context: "global",
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

  test("fails fast on duplicate ids, slash names, and keybindings", () => {
    const provider = new ShellCommandProvider();
    provider.register({
      id: "one",
      title: "One",
      category: "System",
      slash: { name: "one" },
      keybinding: { key: "k", ctrl: true, meta: false, shift: false },
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
        title: "Duplicate keybinding",
        category: "System",
        keybinding: { key: "k", ctrl: true, meta: false, shift: false },
      }),
    ).toThrow("Duplicate shell command keybinding");
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
    ).toBeUndefined();
    expect(provider.createCommandIntent("disabled.command")).toBeUndefined();
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
    expect(
      provider.createSlashCommandIntent("connect", { args: "", source: "slash" }),
    ).toBeUndefined();
    expect(provider.lookupSlashName("questions")).toMatchObject({
      kind: "reserved",
      reservation: {
        owner: "runtime.questions",
      },
    });
    expect(provider.slashCommands().map((command) => command.id)).toContain("agent.model");
    expect(provider.slashCommands().map((command) => command.id)).toContain("session.lineage");
    expect(provider.createSlashCommandIntent("lineage", { args: "", source: "slash" })).toEqual({
      type: "command.invoke",
      commandId: "session.lineage",
      args: "",
      source: "slash",
    });
    expect(provider.slashCommands().map((command) => command.id)).toContain("operator.inbox");
    expect(provider.helpCommands().map((command) => command.id)).not.toContain("agent.connect");
    expect(provider.helpCommands().map((command) => command.id)).not.toContain("session.queue");
    expect(provider.helpCommands().map((command) => command.id)).not.toContain("view.thinking");
    expect(provider.paletteCommands().map((command) => command.id)).toContain("session.queue");
    expect(provider.searchPaletteCommands("connect").map((command) => command.id)).toContain(
      "agent.connect",
    );
    expect(provider.keyboundCommands()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "command.agent.preset.next",
          action: "command:agent.preset.next",
          trigger: { key: "tab", ctrl: false, meta: false, shift: true },
        }),
      ]),
    );
    expect(
      provider.keyboundCommands().some((command) => command.action === "command:app.exit"),
    ).toBe(true);
  });
});
