import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG, type BrewvaConfig } from "@brewva/brewva-runtime";
import { createReadSpansTool, createTocTools } from "@brewva/brewva-tools";
import { requireDefined } from "../../helpers/assertions.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

function createTocWorkspace(prefix: string): string {
  const workspace = createTestWorkspace(prefix);
  mkdirSync(join(workspace, "src"), { recursive: true });
  return workspace;
}

function createRuntime(workspace: string, config?: BrewvaConfig): BrewvaRuntime {
  const runtimeConfig = structuredClone(config ?? DEFAULT_BREWVA_CONFIG);
  runtimeConfig.infrastructure.events.level = "debug";
  return new BrewvaRuntime({ cwd: workspace, config: runtimeConfig });
}

function fakeContext(sessionId: string, cwd: string): any {
  return {
    cwd,
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
  };
}

function extractTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const textPart = result.content.find(
    (item) => item.type === "text" && typeof item.text === "string",
  );
  return textPart?.text ?? "";
}

function sampleFile(workspace: string): string {
  const filePath = join(workspace, "src/runtime.ts");
  writeFileSync(
    filePath,
    [
      "/** Runtime facade and session entrypoints. */",
      "import ts from 'typescript';",
      "import { readFileSync } from 'node:fs';",
      "",
      "/** Create a runtime session. */",
      "export function createSession(name: string): string {",
      "  return name;",
      "}",
      "",
      "/** Build cache state. */",
      "export const buildCache = (value: string): string => value;",
      "",
      "class InternalThing {",
      "  private hidden(): void {}",
      "  public run(task: string): void {}",
      "}",
      "",
      "/** Runtime facade. */",
      "export class BrewvaRuntimeFacade {",
      "  /** Start a turn. */",
      "  startTurn(turn: number): void {}",
      "",
      "  protected guard(): void {}",
      "",
      "  static fromPath(path: string): BrewvaRuntimeFacade {",
      "    return new BrewvaRuntimeFacade();",
      "  }",
      "}",
      "",
      "export const unrelatedValue = 1;",
    ].join("\n"),
    "utf8",
  );
  return filePath;
}

function declarationFile(workspace: string): string {
  const filePath = join(workspace, "src/types.ts");
  writeFileSync(
    filePath,
    [
      "/** Shared runtime type contracts. */",
      "export interface RuntimeSnapshot {",
      "  sessionId: string;",
      "}",
      "",
      "export type SessionState = 'idle' | 'running';",
      "",
      "export enum RuntimeMode {",
      "  Idle = 'idle',",
      "  Active = 'active',",
      "}",
    ].join("\n"),
    "utf8",
  );
  return filePath;
}

function createDirectorySymlink(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

function requireTool<T extends { name: string }>(tools: T[], name: string): T {
  return requireDefined(
    tools.find((tool) => tool.name === name),
    `Expected tool ${name}.`,
  );
}

describe("TOC tools", () => {
  test("toc_document returns imports, symbols, summaries, and public methods only", async () => {
    const workspace = createTocWorkspace("brewva-toc-document-");
    const filePath = sampleFile(workspace);
    const tool = requireTool(createTocTools(), "toc_document");

    const result = await tool.execute(
      "tc-toc-document",
      { file_path: filePath },
      undefined,
      undefined,
      fakeContext("toc-document-session", workspace),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    const details = (result as { details?: Record<string, unknown> }).details;
    expect(text).toContain("[TOCDocument]");
    expect(text).toContain("module_summary: Runtime facade and session entrypoints.");
    expect(text).toContain("source=typescript");
    expect(text).toContain("name=createSession");
    expect(text).toContain("name=buildCache");
    expect(text).toContain("name=BrewvaRuntimeFacade");
    expect(text).toContain("parent=BrewvaRuntimeFacade");
    expect(text).toContain("name=startTurn");
    expect(text).toContain("name=fromPath");
    expect(text).not.toContain("name=guard");
    expect(text).not.toContain("name=hidden");
    expect(details?.status).toBe("ok");
    expect(details?.functionsCount).toBe(2);
    expect(details?.classesCount).toBe(2);
  });

  test("toc_document reuses per-session cache on repeated lookups", async () => {
    const workspace = createTocWorkspace("brewva-toc-cache-");
    const runtime = createRuntime(workspace);
    const filePath = sampleFile(workspace);
    const sessionId = "toc-cache-session";
    const tool = requireTool(createTocTools({ runtime }), "toc_document");

    await tool.execute(
      "tc-toc-document-1",
      { file_path: filePath },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );
    await tool.execute(
      "tc-toc-document-2",
      { file_path: filePath },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );

    const events = runtime.events.query(sessionId, { type: "tool_toc_query" });
    expect(events).toHaveLength(2);
    expect(events[0]?.payload?.cacheHit).toBe(false);
    expect(events[1]?.payload?.cacheHit).toBe(true);
  });

  test("toc_document captures anonymous default-export functions and classes", async () => {
    const workspace = createTocWorkspace("brewva-toc-default-export-");
    const functionFile = join(workspace, "src/default-function.ts");
    const classFile = join(workspace, "src/default-class.ts");
    writeFileSync(
      functionFile,
      [
        "/** Default function export. */",
        "export default function (name: string): string {",
        "  return name;",
        "}",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      classFile,
      ["/** Default class export. */", "export default class {", "  ping(): void {}", "}"].join(
        "\n",
      ),
      "utf8",
    );
    const tool = requireTool(createTocTools(), "toc_document");

    const functionResult = await tool.execute(
      "tc-toc-default-function",
      { file_path: functionFile },
      undefined,
      undefined,
      fakeContext("toc-default-function-session", workspace),
    );
    const functionText = extractTextContent(
      functionResult as { content: Array<{ type: string; text?: string }> },
    );
    expect(functionText).toContain("name=default");
    expect(functionText).toContain('signature="export default function(name: string): string"');

    const classResult = await tool.execute(
      "tc-toc-default-class",
      { file_path: classFile },
      undefined,
      undefined,
      fakeContext("toc-default-class-session", workspace),
    );
    const classText = extractTextContent(
      classResult as { content: Array<{ type: string; text?: string }> },
    );
    expect(classText).toContain("kind=class name=default");
    expect(classText).toContain('signature="export default class"');
    expect(classText).toContain("parent=default");
    expect(classText).toContain("name=ping");
  });

  test("toc_document cache is cleared when runtime session state is cleared", async () => {
    const workspace = createTocWorkspace("brewva-toc-cache-clear-");
    const runtime = createRuntime(workspace);
    const filePath = sampleFile(workspace);
    const sessionId = "toc-cache-clear-session";
    const tool = requireTool(createTocTools({ runtime }), "toc_document");

    await tool.execute(
      "tc-toc-cache-clear-1",
      { file_path: filePath },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );
    runtime.session.clearState(sessionId);
    await tool.execute(
      "tc-toc-cache-clear-2",
      { file_path: filePath },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );

    const events = runtime.events.query(sessionId, { type: "tool_toc_query" });
    expect(events).toHaveLength(2);
    expect(events[0]?.payload?.cacheHit).toBe(false);
    expect(events[1]?.payload?.cacheHit).toBe(false);
  });

  test("toc_document includes interfaces, type aliases, and enums", async () => {
    const workspace = createTocWorkspace("brewva-toc-declarations-");
    const filePath = declarationFile(workspace);
    const tool = requireTool(createTocTools(), "toc_document");

    const result = await tool.execute(
      "tc-toc-declarations",
      { file_path: filePath },
      undefined,
      undefined,
      fakeContext("toc-declarations-session", workspace),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    const details = (result as { details?: Record<string, unknown> }).details;
    expect(text).toContain("[Declarations]");
    expect(text).toContain("kind=interface name=RuntimeSnapshot");
    expect(text).toContain("kind=type_alias name=SessionState");
    expect(text).toContain("kind=enum name=RuntimeMode");
    expect(details?.declarationsCount).toBe(3);
  });

  test("toc_document returns inconclusive for oversized files", async () => {
    const workspace = createTocWorkspace("brewva-toc-document-large-");
    const filePath = join(workspace, "src/huge.ts");
    writeFileSync(filePath, `export const payload = "${"x".repeat(1_100_000)}";\n`, "utf8");
    const tool = requireTool(createTocTools(), "toc_document");

    const result = await tool.execute(
      "tc-toc-document-large",
      { file_path: filePath },
      undefined,
      undefined,
      fakeContext("toc-document-large-session", workspace),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    const details = (result as { details?: Record<string, unknown> }).details;
    expect(text).toContain("reason=file_too_large");
    expect(details?.status).toBe("unavailable");
    expect(details?.reason).toBe("file_too_large");
    expect(details?.verdict).toBe("inconclusive");
  });

  test("toc_search returns focused matches with line spans and telemetry", async () => {
    const workspace = createTocWorkspace("brewva-toc-search-");
    sampleFile(workspace);
    writeFileSync(
      join(workspace, "src/other.ts"),
      ["export function unrelatedThing(): void {}", "export const noop = 1;"].join("\n"),
      "utf8",
    );
    const runtime = createRuntime(workspace);
    const sessionId = "toc-search-session";
    const tool = requireTool(createTocTools({ runtime }), "toc_search");

    const result = await tool.execute(
      "tc-toc-search",
      {
        query: "start turn runtime facade",
        paths: ["src"],
        limit: 5,
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    const details = (result as { details?: Record<string, unknown> }).details;
    expect(text).toContain("[TOCSearch]");
    expect(text).toContain("follow_up_hint: Prefer read_spans");
    expect(text).toContain("kind=class name=BrewvaRuntimeFacade");
    expect(text).toContain("kind=method name=startTurn lines=L21");
    expect(details?.status).toBe("ok");
    expect(details?.candidateFiles).toBe(1);

    const events = runtime.events.query(sessionId, { type: "tool_toc_query" });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload?.broadQuery).toBe(false);
    expect(events[0]?.payload?.candidateFiles).toBe(1);
  });

  test("toc_search ranks exact symbol matches above path-only file matches", async () => {
    const workspace = createTocWorkspace("brewva-toc-ranking-");
    writeFileSync(
      join(workspace, "src/runtime.ts"),
      "export function buildRuntimeHelpers(): void {}\n",
      "utf8",
    );
    writeFileSync(join(workspace, "src/util.ts"), "export function runtime(): void {}\n", "utf8");
    const tool = requireTool(createTocTools(), "toc_search");

    const result = await tool.execute(
      "tc-toc-ranking",
      {
        query: "runtime",
        paths: ["src"],
        limit: 1,
      },
      undefined,
      undefined,
      fakeContext("toc-ranking-session", workspace),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    const firstMatchLine = requireDefined(
      text.split("\n").find((line) => line.startsWith("- score=")),
      "Expected top-ranked TOC search match.",
    );
    expect(firstMatchLine).toContain("kind=function name=runtime");
  });

  test("toc_search avoids duplicate traversal through symlink loops", async () => {
    const workspace = createTocWorkspace("brewva-toc-symlink-");
    sampleFile(workspace);
    createDirectorySymlink(join(workspace, "src"), join(workspace, "src/loop"));
    const tool = requireTool(createTocTools(), "toc_search");

    const result = await tool.execute(
      "tc-toc-symlink",
      {
        query: "runtime facade",
        paths: ["src"],
      },
      undefined,
      undefined,
      fakeContext("toc-symlink-session", workspace),
    );

    const details = (result as { details?: Record<string, unknown> }).details;
    expect(details?.status).toBe("ok");
    expect(details?.indexedFiles).toBe(1);
    expect(details?.candidateFiles).toBe(1);
  });

  test("toc_search returns inconclusive when search scope exceeds the file walk budget", async () => {
    const workspace = createTocWorkspace("brewva-toc-scope-overflow-");
    for (let index = 0; index < 2_050; index += 1) {
      writeFileSync(
        join(workspace, "src", `file-${index}.ts`),
        `export const item${index} = ${index};\n`,
        "utf8",
      );
    }
    const tool = requireTool(createTocTools(), "toc_search");

    const result = await tool.execute(
      "tc-toc-scope-overflow",
      {
        query: "item",
        paths: ["src"],
      },
      undefined,
      undefined,
      fakeContext("toc-scope-overflow-session", workspace),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    const details = (result as { details?: Record<string, unknown> }).details;
    expect(text).toContain("reason: search_scope_too_large");
    expect(details?.status).toBe("unavailable");
    expect(details?.reason).toBe("search_scope_too_large");
    expect(details?.verdict).toBe("inconclusive");
  });

  test("toc_search returns broad_query for generic structural queries", async () => {
    const workspace = createTocWorkspace("brewva-toc-broad-");
    writeFileSync(join(workspace, "src/a.ts"), "export function createAlpha(): void {}\n", "utf8");
    writeFileSync(join(workspace, "src/b.ts"), "export function createBeta(): void {}\n", "utf8");
    writeFileSync(join(workspace, "src/c.ts"), "export function createGamma(): void {}\n", "utf8");
    const tool = requireTool(createTocTools(), "toc_search");

    const result = await tool.execute(
      "tc-toc-broad",
      {
        query: "create",
        paths: ["src"],
      },
      undefined,
      undefined,
      fakeContext("toc-broad-session", workspace),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    const details = (result as { details?: Record<string, unknown> }).details;
    expect(text).toContain("reason: broad_query");
    expect(text).toContain("[TopCandidates]");
    expect(details?.status).toBe("unavailable");
    expect(details?.verdict).toBe("inconclusive");
    expect(details?.reason).toBe("broad_query");
  });

  if (process.platform !== "win32") {
    test("toc_search skips unreadable files instead of failing the whole search", async () => {
      const workspace = createTocWorkspace("brewva-toc-unreadable-");
      sampleFile(workspace);
      const unreadableFile = join(workspace, "src/unreadable.ts");
      writeFileSync(unreadableFile, "export function hiddenThing(): void {}\n", "utf8");
      chmodSync(unreadableFile, 0);

      try {
        const runtime = createRuntime(workspace);
        const tool = requireTool(createTocTools({ runtime }), "toc_search");

        const result = await tool.execute(
          "tc-toc-unreadable",
          {
            query: "runtime facade",
            paths: ["src"],
          },
          undefined,
          undefined,
          fakeContext("toc-unreadable-session", workspace),
        );

        const text = extractTextContent(
          result as { content: Array<{ type: string; text?: string }> },
        );
        const details = (result as { details?: Record<string, unknown> }).details;
        expect(details?.status).toBe("ok");
        expect(details?.candidateFiles).toBe(1);
        expect(details?.skippedFiles).toBe(1);
        expect(text).toContain("skipped_files: 1");
      } finally {
        chmodSync(unreadableFile, 0o644);
      }
    });
  }

  test("read_spans returns merged line ranges without whole-file output", async () => {
    const workspace = createTocWorkspace("brewva-read-spans-");
    const filePath = sampleFile(workspace);
    const tool = createReadSpansTool();

    const result = await tool.execute(
      "tc-read-spans",
      {
        file_path: filePath,
        spans: [
          { start_line: 5, end_line: 6 },
          { start_line: 6, end_line: 8 },
        ],
      },
      undefined,
      undefined,
      fakeContext("read-spans-session", workspace),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    const details = (result as { details?: Record<string, unknown> }).details;
    expect(text).toContain("[ReadSpans]");
    expect(text).toContain("[Span L5-L8]");
    expect(text).toContain("L5: /** Create a runtime session. */");
    expect(text).toContain("L8: }");
    expect(text).not.toContain("L4:");
    expect(details?.status).toBe("ok");
    expect(details?.spansReturned).toBe(1);
  });

  test("read_spans reuses the TOC source cache for the same session and file", async () => {
    const workspace = createTocWorkspace("brewva-read-spans-cache-");
    const runtime = createRuntime(workspace);
    const filePath = sampleFile(workspace);
    const sessionId = "read-spans-cache-session";
    const tocTool = requireTool(createTocTools({ runtime }), "toc_document");
    const readTool = createReadSpansTool({ runtime });

    await tocTool.execute(
      "tc-toc-before-read-spans",
      { file_path: filePath },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );
    const result = await readTool.execute(
      "tc-read-spans-cache",
      {
        file_path: filePath,
        spans: [{ start_line: 5, end_line: 8 }],
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );

    const details = (result as { details?: Record<string, unknown> }).details;
    expect(details?.status).toBe("ok");
    expect(details?.sourceCacheHit).toBe(true);
  });

  test("read_spans source cache is cleared when runtime session state is cleared", async () => {
    const workspace = createTocWorkspace("brewva-read-spans-cache-clear-");
    const runtime = createRuntime(workspace);
    const filePath = sampleFile(workspace);
    const sessionId = "read-spans-cache-clear-session";
    const tocTool = requireTool(createTocTools({ runtime }), "toc_document");
    const readTool = createReadSpansTool({ runtime });

    await tocTool.execute(
      "tc-toc-before-read-spans-cache-clear",
      { file_path: filePath },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );
    runtime.session.clearState(sessionId);

    const result = await readTool.execute(
      "tc-read-spans-cache-clear",
      {
        file_path: filePath,
        spans: [{ start_line: 5, end_line: 8 }],
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );

    const details = (result as { details?: Record<string, unknown> }).details;
    expect(details?.status).toBe("ok");
    expect(details?.sourceCacheHit).toBe(false);
  });

  test("read_spans reports where truncation happened for resume", async () => {
    const workspace = createTocWorkspace("brewva-read-spans-truncate-");
    const filePath = join(workspace, "src/long.ts");
    writeFileSync(
      filePath,
      Array.from(
        { length: 450 },
        (_, index) => `export const line${index + 1} = ${index + 1};`,
      ).join("\n"),
      "utf8",
    );
    const tool = createReadSpansTool();

    const result = await tool.execute(
      "tc-read-spans-truncate",
      {
        file_path: filePath,
        spans: [{ start_line: 1, end_line: 450 }],
      },
      undefined,
      undefined,
      fakeContext("read-spans-truncate-session", workspace),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    const details = (result as { details?: Record<string, unknown> }).details;
    expect(text).toContain("[Truncated]");
    expect(text).toContain("last_line_returned=400");
    expect(text).toContain("truncated_at_line=401");
    expect(details?.truncated).toBe(true);
    expect(details?.lastLineReturned).toBe(400);
    expect(details?.truncatedAtLine).toBe(401);
  });
});
