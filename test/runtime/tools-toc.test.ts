import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG, type BrewvaConfig } from "@brewva/brewva-runtime";
import { createReadSpansTool, createTocTools } from "@brewva/brewva-tools";

function createWorkspace(prefix: string): string {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
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

describe("TOC tools", () => {
  test("toc_document returns imports, symbols, summaries, and public methods only", async () => {
    const workspace = createWorkspace("brewva-toc-document-");
    const filePath = sampleFile(workspace);
    const tool = createTocTools().find((entry) => entry.name === "toc_document");
    expect(tool).toBeDefined();

    const result = await tool!.execute(
      "tc-toc-document",
      { file_path: filePath },
      undefined,
      undefined,
      fakeContext("toc-document-session", workspace),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    const details = (result as { details?: Record<string, unknown> }).details;
    expect(text.includes("[TOCDocument]")).toBe(true);
    expect(text.includes("module_summary: Runtime facade and session entrypoints.")).toBe(true);
    expect(text.includes("source=typescript")).toBe(true);
    expect(text.includes("name=createSession")).toBe(true);
    expect(text.includes("name=buildCache")).toBe(true);
    expect(text.includes("name=BrewvaRuntimeFacade")).toBe(true);
    expect(text.includes("parent=BrewvaRuntimeFacade")).toBe(true);
    expect(text.includes("name=startTurn")).toBe(true);
    expect(text.includes("name=fromPath")).toBe(true);
    expect(text.includes("name=guard")).toBe(false);
    expect(text.includes("name=hidden")).toBe(false);
    expect(details?.status).toBe("ok");
    expect(details?.functionsCount).toBe(2);
    expect(details?.classesCount).toBe(2);
  });

  test("toc_document reuses per-session cache on repeated lookups", async () => {
    const workspace = createWorkspace("brewva-toc-cache-");
    const runtime = createRuntime(workspace);
    const filePath = sampleFile(workspace);
    const sessionId = "toc-cache-session";
    const tool = createTocTools({ runtime }).find((entry) => entry.name === "toc_document");
    expect(tool).toBeDefined();

    await tool!.execute(
      "tc-toc-document-1",
      { file_path: filePath },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );
    await tool!.execute(
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
    const workspace = createWorkspace("brewva-toc-default-export-");
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
    const tool = createTocTools().find((entry) => entry.name === "toc_document");
    expect(tool).toBeDefined();

    const functionResult = await tool!.execute(
      "tc-toc-default-function",
      { file_path: functionFile },
      undefined,
      undefined,
      fakeContext("toc-default-function-session", workspace),
    );
    const functionText = extractTextContent(
      functionResult as { content: Array<{ type: string; text?: string }> },
    );
    expect(functionText.includes("name=default")).toBe(true);
    expect(functionText.includes('signature="export default function(name: string): string"')).toBe(
      true,
    );

    const classResult = await tool!.execute(
      "tc-toc-default-class",
      { file_path: classFile },
      undefined,
      undefined,
      fakeContext("toc-default-class-session", workspace),
    );
    const classText = extractTextContent(
      classResult as { content: Array<{ type: string; text?: string }> },
    );
    expect(classText.includes("kind=class name=default")).toBe(true);
    expect(classText.includes('signature="export default class"')).toBe(true);
    expect(classText.includes("parent=default")).toBe(true);
    expect(classText.includes("name=ping")).toBe(true);
  });

  test("toc_document cache is cleared when runtime session state is cleared", async () => {
    const workspace = createWorkspace("brewva-toc-cache-clear-");
    const runtime = createRuntime(workspace);
    const filePath = sampleFile(workspace);
    const sessionId = "toc-cache-clear-session";
    const tool = createTocTools({ runtime }).find((entry) => entry.name === "toc_document");
    expect(tool).toBeDefined();

    await tool!.execute(
      "tc-toc-cache-clear-1",
      { file_path: filePath },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );
    runtime.session.clearState(sessionId);
    await tool!.execute(
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
    const workspace = createWorkspace("brewva-toc-declarations-");
    const filePath = declarationFile(workspace);
    const tool = createTocTools().find((entry) => entry.name === "toc_document");
    expect(tool).toBeDefined();

    const result = await tool!.execute(
      "tc-toc-declarations",
      { file_path: filePath },
      undefined,
      undefined,
      fakeContext("toc-declarations-session", workspace),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    const details = (result as { details?: Record<string, unknown> }).details;
    expect(text.includes("[Declarations]")).toBe(true);
    expect(text.includes("kind=interface name=RuntimeSnapshot")).toBe(true);
    expect(text.includes("kind=type_alias name=SessionState")).toBe(true);
    expect(text.includes("kind=enum name=RuntimeMode")).toBe(true);
    expect(details?.declarationsCount).toBe(3);
  });

  test("toc_search returns focused matches with line spans and telemetry", async () => {
    const workspace = createWorkspace("brewva-toc-search-");
    sampleFile(workspace);
    writeFileSync(
      join(workspace, "src/other.ts"),
      ["export function unrelatedThing(): void {}", "export const noop = 1;"].join("\n"),
      "utf8",
    );
    const runtime = createRuntime(workspace);
    const sessionId = "toc-search-session";
    const tool = createTocTools({ runtime }).find((entry) => entry.name === "toc_search");
    expect(tool).toBeDefined();

    const result = await tool!.execute(
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
    expect(text.includes("[TOCSearch]")).toBe(true);
    expect(text.includes("follow_up_hint: Prefer read_spans")).toBe(true);
    expect(text.includes("kind=class name=BrewvaRuntimeFacade")).toBe(true);
    expect(text.includes("kind=method name=startTurn lines=L21")).toBe(true);
    expect(details?.status).toBe("ok");
    expect(details?.candidateFiles).toBe(1);

    const events = runtime.events.query(sessionId, { type: "tool_toc_query" });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload?.broadQuery).toBe(false);
    expect(events[0]?.payload?.candidateFiles).toBe(1);
  });

  test("toc_search ranks exact symbol matches above path-only file matches", async () => {
    const workspace = createWorkspace("brewva-toc-ranking-");
    writeFileSync(
      join(workspace, "src/runtime.ts"),
      "export function buildRuntimeHelpers(): void {}\n",
      "utf8",
    );
    writeFileSync(join(workspace, "src/util.ts"), "export function runtime(): void {}\n", "utf8");
    const tool = createTocTools().find((entry) => entry.name === "toc_search");
    expect(tool).toBeDefined();

    const result = await tool!.execute(
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
    const firstMatchLine = text.split("\n").find((line) => line.startsWith("- score="));
    expect(firstMatchLine?.includes("kind=function name=runtime")).toBe(true);
  });

  test("toc_search avoids duplicate traversal through symlink loops", async () => {
    const workspace = createWorkspace("brewva-toc-symlink-");
    sampleFile(workspace);
    createDirectorySymlink(join(workspace, "src"), join(workspace, "src/loop"));
    const tool = createTocTools().find((entry) => entry.name === "toc_search");
    expect(tool).toBeDefined();

    const result = await tool!.execute(
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

  test("toc_search returns broad_query for generic structural queries", async () => {
    const workspace = createWorkspace("brewva-toc-broad-");
    writeFileSync(join(workspace, "src/a.ts"), "export function createAlpha(): void {}\n", "utf8");
    writeFileSync(join(workspace, "src/b.ts"), "export function createBeta(): void {}\n", "utf8");
    writeFileSync(join(workspace, "src/c.ts"), "export function createGamma(): void {}\n", "utf8");
    const tool = createTocTools().find((entry) => entry.name === "toc_search");
    expect(tool).toBeDefined();

    const result = await tool!.execute(
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
    expect(text.includes("reason: broad_query")).toBe(true);
    expect(text.includes("[TopCandidates]")).toBe(true);
    expect(details?.status).toBe("unavailable");
    expect(details?.verdict).toBe("inconclusive");
    expect(details?.reason).toBe("broad_query");
  });

  if (process.platform !== "win32") {
    test("toc_search skips unreadable files instead of failing the whole search", async () => {
      const workspace = createWorkspace("brewva-toc-unreadable-");
      sampleFile(workspace);
      const unreadableFile = join(workspace, "src/unreadable.ts");
      writeFileSync(unreadableFile, "export function hiddenThing(): void {}\n", "utf8");
      chmodSync(unreadableFile, 0);

      try {
        const runtime = createRuntime(workspace);
        const tool = createTocTools({ runtime }).find((entry) => entry.name === "toc_search");
        expect(tool).toBeDefined();

        const result = await tool!.execute(
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
        expect(text.includes("skipped_files: 1")).toBe(true);
      } finally {
        chmodSync(unreadableFile, 0o644);
      }
    });
  }

  test("read_spans returns merged line ranges without whole-file output", async () => {
    const workspace = createWorkspace("brewva-read-spans-");
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
    expect(text.includes("[ReadSpans]")).toBe(true);
    expect(text.includes("[Span L5-L8]")).toBe(true);
    expect(text.includes("L5: /** Create a runtime session. */")).toBe(true);
    expect(text.includes("L8: }")).toBe(true);
    expect(text.includes("L4:")).toBe(false);
    expect(details?.status).toBe("ok");
    expect(details?.spansReturned).toBe(1);
  });

  test("read_spans reports where truncation happened for resume", async () => {
    const workspace = createWorkspace("brewva-read-spans-truncate-");
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
    expect(text.includes("[Truncated]")).toBe(true);
    expect(text.includes("last_line_returned=400")).toBe(true);
    expect(text.includes("truncated_at_line=401")).toBe(true);
    expect(details?.truncated).toBe(true);
    expect(details?.lastLineReturned).toBe(400);
    expect(details?.truncatedAtLine).toBe(401);
  });
});
