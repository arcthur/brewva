import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSourceDependencyGraph,
  clearSourceIntelligenceCaches,
  createSourceIntelligenceEngine,
} from "../../../packages/brewva-tools/src/families/navigation/source-intelligence/engine.js";

function makeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "brewva-source-intelligence-"));
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(
    join(workspace, "src/main.ts"),
    [
      'import { helper } from "./helper";',
      "export interface User { name: string }",
      "export class Service {",
      "  run(user: User) { return helper(user.name); }",
      "}",
      "export function entry(user: User) {",
      "  return new Service().run(user);",
      "}",
      "export const alpha = 1, beta = 2;",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(workspace, "src/barrel.ts"),
    ['export { helper as exportedHelper } from "./helper";', 'export * from "./main";', ""].join(
      "\n",
    ),
    "utf8",
  );
  writeFileSync(
    join(workspace, "src/helper.ts"),
    [
      "export function helper(name: string): string {",
      "  return name.toUpperCase();",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(workspace, "src/alt-helper.ts"),
    ["export function helper(value?: string): string {", '  return value ?? "alt";', "}", ""].join(
      "\n",
    ),
    "utf8",
  );
  writeFileSync(
    join(workspace, "src/loose.ts"),
    ["export function start() {", "  return helper();", "}", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(workspace, "src/internal.ts"),
    ["export function internalOnly() {", '  return "hidden";', "}", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify(
      {
        name: "source-intelligence-fixture",
        exports: {
          ".": "./src/barrel.ts",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(join(workspace, ".gitignore"), "generated/\n", "utf8");
  mkdirSync(join(workspace, "generated"), { recursive: true });
  writeFileSync(
    join(workspace, "generated/ignored.ts"),
    ["export function ignoredGeneratedApi() {", "  return null;", "}", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(workspace, "worker.py"),
    [
      "from .py_helper import (",
      "    Service,",
      ")",
      "__all__ = (",
      "    'run',",
      ")",
      "__all__ += ['Worker']",
      "class Worker:",
      "    pass",
      "def hidden():",
      "    return 'hidden'",
      "def run(value):",
      "    return value",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(workspace, "py_helper.py"),
    ["class Service:", "    pass", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(workspace, "worker.go"),
    [
      "package main",
      "import (",
      ' "fmt"',
      ")",
      "type (",
      " Worker struct{}",
      ")",
      "func Run(value string) string {",
      " return fmt.Sprint(value)",
      "}",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(workspace, "worker.rs"),
    ["use crate::helper::run;", "pub struct Worker;", "pub fn execute() {", " run();", "}"].join(
      "\n",
    ),
    "utf8",
  );
  return workspace;
}

describe("source intelligence engine", () => {
  test("parses TypeScript with OXC-backed declarations, imports, calls, and byte spans", async () => {
    clearSourceIntelligenceCaches();
    const workspace = makeWorkspace();
    const engine = createSourceIntelligenceEngine({ workspaceRoot: workspace });

    const document = await engine.loadDocument(join(workspace, "src/main.ts"));

    expect(document.language).toBe("typescript");
    expect(document.imports.map((entry) => entry.module)).toContain("./helper");
    expect(document.declarations.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(
      expect.arrayContaining([
        "interface:User",
        "class:Service",
        "method:run",
        "function:entry",
        "const:alpha",
        "const:beta",
      ]),
    );
    expect(document.declarations.every((entry) => entry.span.startByte < entry.span.endByte)).toBe(
      true,
    );
    expect(document.calls.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["helper", "Service", "run"]),
    );
    expect(document.calls.find((entry) => entry.name === "helper")?.enclosingDeclaration).toBe(
      "run",
    );
  });

  test("parses Python, Go, and Rust through source-intelligence adapters", async () => {
    clearSourceIntelligenceCaches();
    const workspace = makeWorkspace();
    const engine = createSourceIntelligenceEngine({ workspaceRoot: workspace });

    const python = await engine.loadDocument(join(workspace, "worker.py"));
    const go = await engine.loadDocument(join(workspace, "worker.go"));
    const rust = await engine.loadDocument(join(workspace, "worker.rs"));

    expect(python.language).toBe("python");
    expect(python.imports.map((entry) => entry.module)).toContain(".py_helper");
    expect(python.declarations.map((entry) => `${entry.kind}:${entry.name}`)).toContain(
      "function:run",
    );
    expect(go.language).toBe("go");
    expect(go.declarations.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(
      expect.arrayContaining(["struct:Worker", "function:Run"]),
    );
    expect(rust.language).toBe("rust");
    expect(rust.declarations.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(
      expect.arrayContaining(["struct:Worker", "function:execute"]),
    );
  });

  test("parses package manifests as project structure documents", async () => {
    clearSourceIntelligenceCaches();
    const workspace = makeWorkspace();
    const engine = createSourceIntelligenceEngine({ workspaceRoot: workspace });

    const manifest = await engine.loadDocument(join(workspace, "package.json"));

    expect(manifest.language).toBe("json");
    expect(manifest.declarations.map((entry) => `${entry.kind}:${entry.name}`)).toContain(
      "module:source-intelligence-fixture",
    );
    expect(manifest.imports.map((entry) => entry.rawSpecifier)).toContain("./src/barrel.ts");
  });

  test("builds forward, reverse, and cycle-safe dependency graphs", async () => {
    clearSourceIntelligenceCaches();
    const workspace = makeWorkspace();
    const engine = createSourceIntelligenceEngine({ workspaceRoot: workspace });

    const graph = await buildSourceDependencyGraph(engine, [join(workspace, "src")]);
    const fullGraph = await buildSourceDependencyGraph(engine, [workspace]);

    expect(graph.edges.some((edge) => edge.rawSpecifier === "./helper")).toBe(true);
    expect(graph.reverseEdges.length).toBeGreaterThan(0);
    expect(graph.cycles).toEqual([]);
    expect(
      fullGraph.edges.some(
        (edge) =>
          edge.fromPath.endsWith("worker.py") &&
          edge.rawSpecifier === ".py_helper" &&
          edge.toPath?.endsWith("py_helper.py"),
      ),
    ).toBe(true);
  });

  test("workspace document listing honors root gitignore directory rules", async () => {
    clearSourceIntelligenceCaches();
    const workspace = makeWorkspace();
    const engine = createSourceIntelligenceEngine({ workspaceRoot: workspace });

    const documents = await engine.listDocuments();

    expect(documents.map((document) => document.filePath)).not.toContain(
      join(workspace, "generated/ignored.ts"),
    );
  });

  test("workspace document listing honors caller-provided skipped directories", async () => {
    clearSourceIntelligenceCaches();
    const workspace = makeWorkspace();
    mkdirSync(join(workspace, ".local-index"), { recursive: true });
    writeFileSync(
      join(workspace, ".local-index/cache.ts"),
      ["export function cachedArtifact() {", "  return null;", "}", ""].join("\n"),
      "utf8",
    );
    const engine = createSourceIntelligenceEngine({
      workspaceRoot: workspace,
      extraSkippedDirectories: [".local-index"],
    });

    const documents = await engine.listDocuments();

    expect(documents.map((document) => document.filePath)).not.toContain(
      join(workspace, ".local-index/cache.ts"),
    );
  });

  test("resolves surface re-exports and callees from declaration bodies", async () => {
    clearSourceIntelligenceCaches();
    const workspace = makeWorkspace();
    const engine = createSourceIntelligenceEngine({ workspaceRoot: workspace });

    const surface = await engine.resolveSurface(join(workspace, "src/barrel.ts"));
    expect(surface.reExports.map((entry) => entry.rawSpecifier)).toEqual(
      expect.arrayContaining(["./helper", "./main"]),
    );
    expect(surface.reExports.every((entry) => entry.kind === "re-export")).toBe(true);
    const packageSurface = await engine.resolveSurface(workspace);
    expect(packageSurface.declarations.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["exportedHelper", "entry"]),
    );
    expect(packageSurface.declarations.map((entry) => entry.name)).not.toContain("internalOnly");

    const pythonSurface = await engine.resolveSurface(join(workspace, "worker.py"));
    expect(pythonSurface.declarations.map((entry) => entry.name)).toEqual(["Worker", "run"]);

    const callees = await engine.findCallees({
      symbol: "run",
      filePath: join(workspace, "src/main.ts"),
    });
    expect(callees.map((edge) => edge.rawSpecifier)).toContain("helper");
    expect(callees.every((edge) => !edge.editAuthority)).toBe(true);
  });

  test("marks unresolved multi-candidate calls as ambiguous instead of exact", async () => {
    clearSourceIntelligenceCaches();
    const workspace = makeWorkspace();
    const engine = createSourceIntelligenceEngine({ workspaceRoot: workspace });

    const callers = await engine.findCallers({
      symbol: "helper",
      filePath: join(workspace, "src/helper.ts"),
    });

    expect(
      callers.some((edge) => edge.fromPath.endsWith("src/main.ts") && edge.confidence === "exact"),
    ).toBe(true);
    expect(
      callers.some(
        (edge) => edge.fromPath.endsWith("src/loose.ts") && edge.confidence === "ambiguous",
      ),
    ).toBe(true);
  });
});
