import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellCommandProvider } from "../../../packages/brewva-cli/src/shell/commands/command-provider.js";
import {
  ShellCompletionProvider,
  createAgentCompletionSource,
  createCommandCompletionSource,
  createInMemoryCompletionUsageStore,
  createWorkspaceReferenceCompletionSource,
  type ShellCompletionRange,
} from "../../../packages/brewva-cli/src/shell/domain/completion-provider.js";
import { requireDefined } from "../../helpers/assertions.js";

function completionRange(trigger: "/" | "@", query: string): ShellCompletionRange {
  return {
    trigger,
    query,
    start: 0,
    end: query.length + 1,
  };
}

function createCommandProvider(): ShellCommandProvider {
  const provider = new ShellCommandProvider();
  provider.register({
    id: "agent.model",
    title: "Switch Model",
    description: "Choose the active model",
    category: "Agent",
    slash: { name: "model" },
  });
  provider.register({
    id: "agent.connect",
    title: "Connect Provider",
    description: "Connect a model provider",
    category: "Agent",
    slash: { name: "connect", visibility: "hidden" },
  });
  provider.register({
    id: "session.quit",
    title: "Quit",
    description: "Exit the shell",
    category: "Session",
    slash: { name: "quit" },
  });
  provider.register({
    id: "session.sessions",
    title: "Switch Session",
    description: "Browse and switch replay sessions.",
    category: "Session",
    slash: { name: "sessions" },
  });
  provider.register({
    id: "session.inspect",
    title: "Inspect Session",
    description: "Replay-first work card for the current session.",
    category: "Session",
    slash: { name: "inspect" },
  });
  return provider;
}

async function primedProvider(input: {
  cwd: string;
  extraSources?: ReturnType<typeof createAgentCompletionSource>[];
  usageStore?: ReturnType<typeof createInMemoryCompletionUsageStore>;
  primeQueries: readonly string[];
}): Promise<ShellCompletionProvider> {
  const workspaceSource = createWorkspaceReferenceCompletionSource({ cwd: input.cwd });
  const provider = new ShellCompletionProvider({
    sources: [...(input.extraSources ?? []), workspaceSource],
    usageStore: input.usageStore ?? createInMemoryCompletionUsageStore(),
  });
  // Resolution is cache-backed: each round serves cached parents and
  // schedules fills for newly discovered children, so prime until the
  // walk depth is fully populated.
  for (let round = 0; round < 6; round += 1) {
    for (const query of input.primeQueries) {
      provider.resolve(completionRange("@", query));
    }
    await workspaceSource.settleFills();
  }
  return provider;
}

describe("ShellCompletionProvider", () => {
  test("/ completion only returns command candidates from ShellCommandProvider", () => {
    const provider = new ShellCompletionProvider({
      sources: [
        createCommandCompletionSource(createCommandProvider()),
        createAgentCompletionSource(() => [{ agentId: "reviewer", description: "Review agent" }]),
      ],
      usageStore: createInMemoryCompletionUsageStore(),
    });

    const results = provider.resolve(completionRange("/", "mod"));

    expect(results.map((candidate) => candidate.kind)).toEqual(["command"]);
    expect(results[0]).toMatchObject({
      value: "model",
      label: "/model",
      accept: {
        type: "runCommand",
        commandId: "agent.model",
      },
    });
  });

  test("/ completion shows empty-query commands in slash-name order", () => {
    const commands = new ShellCommandProvider();
    commands.register({
      id: "system.gamma",
      title: "Gamma",
      description: "Third",
      category: "System",
      slash: { name: "zeta" },
      suggested: true,
    });
    commands.register({
      id: "system.alpha",
      title: "Alpha",
      description: "First",
      category: "System",
      slash: { name: "alpha" },
    });
    commands.register({
      id: "system.beta",
      title: "Beta",
      description: "Second",
      category: "System",
      slash: { name: "beta" },
    });

    const provider = new ShellCompletionProvider({
      sources: [createCommandCompletionSource(commands)],
      usageStore: createInMemoryCompletionUsageStore(),
    });

    expect(provider.resolve(completionRange("/", "")).map((candidate) => candidate.value)).toEqual([
      "alpha",
      "beta",
      "zeta",
    ]);
  });

  test("/ completion ranks slash name matches ahead of command metadata matches", () => {
    const provider = new ShellCompletionProvider({
      sources: [createCommandCompletionSource(createCommandProvider())],
      usageStore: createInMemoryCompletionUsageStore(),
    });

    const results = provider.resolve(completionRange("/", "se"));

    expect(results[0]).toMatchObject({
      kind: "command",
      value: "sessions",
      accept: {
        type: "runCommand",
        commandId: "session.sessions",
      },
    });
  });

  test("/ completion does not let command frecency promote non-name matches", () => {
    const provider = new ShellCompletionProvider({
      sources: [createCommandCompletionSource(createCommandProvider())],
      usageStore: createInMemoryCompletionUsageStore([
        {
          kind: "command",
          value: "agent.model",
          count: 100,
          lastUsedAt: Date.now(),
        },
      ]),
    });

    const results = provider.resolve(completionRange("/", "se"));

    expect(results[0]).toMatchObject({
      kind: "command",
      value: "sessions",
    });
    expect(results.map((candidate) => candidate.value)).not.toContain("model");
  });

  test("/ completion omits palette-only commands that are not slash-visible", () => {
    const provider = new ShellCompletionProvider({
      sources: [createCommandCompletionSource(createCommandProvider())],
      usageStore: createInMemoryCompletionUsageStore(),
    });

    const results = provider.resolve(completionRange("/", "con"));

    expect(results).toEqual([]);
  });

  test("@ completion mixes agents, files, and directories with fuzzy path matching", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-shell-completion-"));
    mkdirSync(join(cwd, "packages"), { recursive: true });
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "README.md"), "# Test\n");
    writeFileSync(join(cwd, "src", "command-provider.ts"), "export {};\n");

    const provider = await primedProvider({
      cwd,
      extraSources: [
        createAgentCompletionSource(() => [
          { agentId: "reviewer", description: "Code review agent" },
          { agentId: "builder", description: "Patch agent" },
        ]),
      ],
      primeQueries: ["", "provider"],
    });

    const broad = provider.resolve(completionRange("@", ""));
    expect(broad.map((candidate) => candidate.kind)).toEqual(
      expect.arrayContaining(["agent", "file", "directory"]),
    );

    const fileMatches = provider.resolve(completionRange("@", "provider"));
    expect(fileMatches[0]).toMatchObject({
      kind: "file",
      value: "src/command-provider.ts",
      accept: {
        type: "insertFilePart",
        path: "src/command-provider.ts",
      },
    });
  });

  test("space-bearing directories keep reference completion expandable", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-shell-completion-spaces-"));
    mkdirSync(join(cwd, "my dir", "nested"), { recursive: true });

    const provider = await primedProvider({ cwd, primeQueries: ["my", "my dir/"] });

    const topLevel = provider.resolve(completionRange("@", "my"));
    expect(topLevel[0]).toMatchObject({
      kind: "directory",
      value: '"my dir/',
      accept: {
        type: "insertDirectoryText",
        text: '"my dir/',
      },
    });

    const nested = provider.resolve(completionRange("@", "my dir/"));
    expect(nested[0]).toMatchObject({
      kind: "directory",
      value: '"my dir/nested/',
    });
  });

  test("@ file completion preserves line ranges while matching by base path", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-shell-completion-lines-"));
    writeFileSync(join(cwd, "README.md"), "# Test\n");

    const provider = await primedProvider({ cwd, primeQueries: ["README.md#L10-L20"] });

    const matches = provider.resolve(completionRange("@", "README.md#L10-L20"));

    expect(matches[0]).toMatchObject({
      kind: "file",
      value: "README.md#L10-L20",
      accept: {
        type: "insertFilePart",
        path: "README.md#L10-L20",
      },
    });
  });

  test("@ file completion keeps line ranges inside quoted spaced paths", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-shell-completion-spaced-lines-"));
    writeFileSync(join(cwd, "my file.ts"), "export {};\n");

    const provider = await primedProvider({ cwd, primeQueries: ["my file.ts#L3"] });

    const matches = provider.resolve(completionRange("@", "my file.ts#L3"));

    expect(matches[0]).toMatchObject({
      kind: "file",
      value: '"my file.ts#L3"',
      accept: {
        type: "insertFilePart",
        path: '"my file.ts#L3"',
      },
    });
  });

  test("frecency promotes matching candidates without surfacing non-matches", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-shell-completion-frecency-"));
    mkdirSync(join(cwd, "docs"), { recursive: true });
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "docs", "provider.ts"), "export {};\n");
    writeFileSync(join(cwd, "src", "provider.ts"), "export {};\n");

    const usageStore = createInMemoryCompletionUsageStore();
    const provider = await primedProvider({ cwd, usageStore, primeQueries: ["provider"] });

    const before = provider.resolve(completionRange("@", "provider"));
    expect(before.map((candidate) => candidate.value)).toEqual([
      "docs/provider.ts",
      "src/provider.ts",
    ]);

    const srcProvider = requireDefined(
      before.find((candidate) => candidate.value === "src/provider.ts"),
      "expected src/provider.ts completion candidate",
    );
    provider.recordAccepted(srcProvider);

    const after = provider.resolve(completionRange("@", "provider"));
    expect(after.map((candidate) => candidate.value)).toEqual([
      "src/provider.ts",
      "docs/provider.ts",
    ]);

    expect(provider.resolve(completionRange("@", "definitely-missing"))).toEqual([]);
  });

  test("frecency caps usage memory and decays stale entries", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-shell-completion-decay-"));
    mkdirSync(join(cwd, "docs"), { recursive: true });
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "docs", "provider.ts"), "export {};\n");
    writeFileSync(join(cwd, "src", "provider.ts"), "export {};\n");
    const now = Date.now();
    const usageStore = createInMemoryCompletionUsageStore(
      [
        {
          kind: "file",
          value: "docs/provider.ts",
          count: 100,
          lastUsedAt: now - 365 * 24 * 60 * 60 * 1000,
        },
        {
          kind: "file",
          value: "src/provider.ts",
          count: 1,
          lastUsedAt: now,
        },
      ],
      undefined,
      { maxEntries: 2 },
    );
    const provider = await primedProvider({ cwd, usageStore, primeQueries: ["provider"] });

    expect(provider.resolve(completionRange("@", "provider"))[0]?.value).toBe("src/provider.ts");

    usageStore.recordAccepted({
      id: "file:README.md",
      kind: "file",
      source: "workspace",
      label: "@README.md",
      value: "README.md",
      insertText: "README.md",
      accept: {
        type: "insertFilePart",
        path: "README.md",
      },
    });

    expect(
      usageStore.get({
        id: "file:docs/provider.ts",
        kind: "file",
        source: "workspace",
        label: "@docs/provider.ts",
        value: "docs/provider.ts",
        insertText: "docs/provider.ts",
        accept: {
          type: "insertFilePart",
          path: "docs/provider.ts",
        },
      }),
    ).toBe(undefined);
  });

  test("workspace reference completion stays inside cwd for parent and absolute queries", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-shell-completion-boundary-"));
    const cwd = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "outside\n");

    const provider = new ShellCompletionProvider({
      sources: [createWorkspaceReferenceCompletionSource({ cwd })],
      usageStore: createInMemoryCompletionUsageStore(),
    });

    expect(provider.resolve(completionRange("@", "../outside/"))).toEqual([]);
    expect(provider.resolve(completionRange("@", `${outside}/`))).toEqual([]);
  });

  test("usage entries store stable typed values instead of display labels", () => {
    const usageStore = createInMemoryCompletionUsageStore();

    expect(
      usageStore.recordAccepted({
        id: "command:agent.model",
        kind: "command",
        source: "command",
        label: "/model",
        value: "model",
        insertText: "/model ",
        accept: {
          type: "runCommand",
          commandId: "agent.model",
          insertText: "/model ",
          argumentMode: "optional",
        },
      }),
    ).toMatchObject({ kind: "command", value: "agent.model" });

    expect(
      usageStore.recordAccepted({
        id: 'file:"docs/has spaces.md"',
        kind: "file",
        source: "workspace",
        label: '@"docs/has spaces.md"',
        value: '"docs/has spaces.md"',
        insertText: '"docs/has spaces.md"',
        accept: {
          type: "insertFilePart",
          path: '"docs/has spaces.md"',
        },
      }),
    ).toMatchObject({ kind: "file", value: "docs/has spaces.md" });

    expect(
      usageStore.recordAccepted({
        id: "file:docs/range.md#L2-L4",
        kind: "file",
        source: "workspace",
        label: "@docs/range.md#L2-L4",
        value: "docs/range.md#L2-L4",
        insertText: "docs/range.md#L2-L4",
        accept: {
          type: "insertFilePart",
          path: "docs/range.md#L2-L4",
        },
      }),
    ).toMatchObject({ kind: "file", value: "docs/range.md" });
  });
});
