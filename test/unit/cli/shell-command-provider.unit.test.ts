import { describe, expect, test } from "bun:test";
import { ShellCommandProvider } from "../../../packages/brewva-cli/src/shell/command-provider.js";

describe("shell command provider", () => {
  test("derives visible, slash, and keybound command surfaces from registered commands", () => {
    const provider = new ShellCommandProvider();
    provider.register({
      id: "model.list",
      title: "Switch model",
      description: "Select a model.",
      category: "Agent",
      slash: { name: "models", aliases: ["model"], argumentMode: "optional" },
      keybinding: { key: "m", ctrl: true, meta: false, shift: false },
      suggested: true,
      run: () => {},
    });
    provider.register({
      id: "hidden.internal",
      title: "Hidden internal",
      category: "System",
      slash: { name: "hidden" },
      hidden: true,
      run: () => {},
    });
    provider.register({
      id: "disabled.command",
      title: "Disabled command",
      category: "System",
      slash: { name: "disabled" },
      keybinding: { key: "d", ctrl: true, meta: false, shift: false },
      enabled: false,
      run: () => {},
    });

    expect(provider.visibleCommands().map((command) => command.id)).toEqual(["model.list"]);
    expect(provider.slashCommands()).toEqual([
      {
        command: "models",
        aliases: ["model"],
        description: "Select a model.",
        argumentMode: "optional",
      },
    ]);
    expect(provider.keyboundCommands()).toMatchObject([
      {
        id: "command.model.list",
        action: "command:model.list",
        context: "global",
      },
    ]);
  });

  test("search matches title, description, category, slash name, and slash aliases", () => {
    const provider = new ShellCommandProvider();
    provider.register({
      id: "operator.questions",
      title: "Operator questions",
      description: "Open the operator inbox for pending input.",
      category: "Operator",
      slash: { name: "questions", aliases: ["inbox"] },
      run: () => {},
    });

    expect(provider.searchCommands("operator").map((command) => command.id)).toEqual([
      "operator.questions",
    ]);
    expect(provider.searchCommands("pending").map((command) => command.id)).toEqual([
      "operator.questions",
    ]);
    expect(provider.searchCommands("/questions").map((command) => command.id)).toEqual([
      "operator.questions",
    ]);
    expect(provider.searchCommands("inbox").map((command) => command.id)).toEqual([
      "operator.questions",
    ]);
    expect(provider.searchCommands("opq").map((command) => command.id)).toEqual([
      "operator.questions",
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
      run: () => {},
    });

    expect(() =>
      provider.register({
        id: "one",
        title: "Duplicate id",
        category: "System",
        run: () => {},
      }),
    ).toThrow("Duplicate shell command id");
    expect(() =>
      provider.register({
        id: "two",
        title: "Duplicate slash",
        category: "System",
        slash: { name: "one" },
        run: () => {},
      }),
    ).toThrow("Duplicate shell command slash name");
    expect(() =>
      provider.register({
        id: "three",
        title: "Duplicate keybinding",
        category: "System",
        keybinding: { key: "k", ctrl: true, meta: false, shift: false },
        run: () => {},
      }),
    ).toThrow("Duplicate shell command keybinding");
  });

  test("hidden commands stay executable by id", async () => {
    const provider = new ShellCommandProvider();
    let ran = false;
    provider.register({
      id: "hidden.internal",
      title: "Hidden internal",
      category: "System",
      hidden: true,
      run: () => {
        ran = true;
      },
    });

    expect(provider.visibleCommands()).toEqual([]);
    expect(await provider.runCommand("hidden.internal")).toBe(true);
    expect(ran).toBe(true);
  });
});
