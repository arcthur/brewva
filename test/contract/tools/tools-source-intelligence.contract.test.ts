import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokenCount } from "@brewva/brewva-token-estimation";
import { buildBrewvaTools } from "@brewva/brewva-tools";
import type { BrewvaBundledToolRuntime } from "@brewva/brewva-tools/contracts";
import { createSourceIntelligenceTools } from "@brewva/brewva-tools/navigation";
import { resolveBrewvaToolExecutionTraits } from "@brewva/brewva-tools/registry";
import { requireDefined } from "../../helpers/assertions.js";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";
import { createBundledToolRuntime } from "../../helpers/runtime.js";
import { toolOutcomePayload } from "../../helpers/tool-outcome.js";
import { extractTextContent, fakeContext } from "./tools-flow.helpers.js";

function requireTool<T extends { name: string }>(tools: T[], name: string): T {
  return requireDefined(
    tools.find((tool) => tool.name === name),
    `Expected tool ${name}.`,
  );
}

function makeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "brewva-code-tools-"));
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(
    join(workspace, "src/index.ts"),
    [
      'import { helper } from "./helper";',
      "export class Runner {",
      "  start() { return helper(); }",
      "}",
      "export function main() { return new Runner().start(); }",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(workspace, "src/helper.ts"),
    ["export function helper() {", '  return "ok";', "}", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(workspace, "src/alt-helper.ts"),
    ["export function helper() {", '  return "alt";', "}", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(workspace, "src/loose.ts"),
    ["export function startLoose() {", "  return helper();", "}", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(workspace, "src/internal.ts"),
    ["export function internalOnly() {", '  return "hidden";', "}", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(workspace, "src/barrel.ts"),
    ['export { helper as exportedHelper } from "./helper";', 'export * from "./index";', ""].join(
      "\n",
    ),
    "utf8",
  );
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify(
      {
        name: "source-intelligence-tool-fixture",
        exports: {
          ".": "./src/barrel.ts",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(join(workspace, "README.md"), "# Fixture\n", "utf8");
  writeFileSync(
    join(workspace, "tool.py"),
    ["__all__ = ['run']", "def run():", "    return 'ok'", ""].join("\n"),
    "utf8",
  );
  return workspace;
}

function runtimeFor(workspace: string): BrewvaBundledToolRuntime {
  return createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }));
}

describe("source intelligence managed tools", () => {
  test("default bundle exposes code_* tools and removes toc_* plus lsp_symbols", () => {
    const workspace = makeWorkspace();
    const tools = buildBrewvaTools({ runtime: runtimeFor(workspace) });
    const names = tools.map((tool) => tool.name).toSorted();

    expect(names).toEqual(
      expect.arrayContaining([
        "code_outline",
        "code_digest",
        "code_surface",
        "code_deps",
        "code_reverse_deps",
        "code_cycles",
        "code_callers",
        "code_callees",
      ]),
    );
    expect(names).not.toContain("toc_document");
    expect(names).not.toContain("toc_search");
    expect(names).not.toContain("lsp_symbols");
  });

  test("source intelligence tools advertise cancelable execution traits", () => {
    const workspace = makeWorkspace();
    const tools = createSourceIntelligenceTools({ runtime: runtimeFor(workspace) });

    for (const tool of tools) {
      const traits = resolveBrewvaToolExecutionTraits(tool, {
        args: {},
        cwd: workspace,
      });
      expect(traits).toEqual({
        concurrencySafe: true,
        interruptBehavior: "cancel",
        streamingEligible: false,
        contextModifying: false,
      });
    }
  });

  test("code_outline returns language-neutral outline details and records source intelligence telemetry", async () => {
    const workspace = makeWorkspace();
    const runtime = createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }));
    const tools = createSourceIntelligenceTools({ runtime });
    const codeOutline = requireTool(tools, "code_outline");

    const result = await codeOutline.execute(
      "tc-code-outline",
      { file_path: join(workspace, "src/index.ts") },
      undefined,
      undefined,
      fakeContext("source-intelligence-outline"),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("[CodeOutline]");
    expect(text).toContain("class Runner");
    expect(text).toContain("function main");
    expect((toolOutcomePayload(result) as { declarationsCount?: number }).declarationsCount).toBe(
      3,
    );
    expect(
      runtime.capabilities.events.records.query("source-intelligence-outline", {
        type: "tool_source_intelligence",
      }).length,
    ).toBeGreaterThan(0);
  });

  test("code_outline supports package manifests used during architecture exploration", async () => {
    const workspace = makeWorkspace();
    const tools = createSourceIntelligenceTools({ runtime: runtimeFor(workspace) });
    const codeOutline = requireTool(tools, "code_outline");

    const result = await codeOutline.execute(
      "tc-code-outline-package-manifest",
      { file_path: join(workspace, "package.json") },
      undefined,
      undefined,
      fakeContext("source-intelligence-outline-package"),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("[CodeOutline]");
    expect(text).toContain("language: json");
    expect(text).toContain("module source-intelligence-tool-fixture");
    expect(text).toContain("./src/barrel.ts");
    expect((toolOutcomePayload(result) as { status?: string }).status).toBe("ok");
  });

  test("code_digest uses token budget accounting and supports Python outlines", async () => {
    const workspace = makeWorkspace();
    const tools = createSourceIntelligenceTools({ runtime: runtimeFor(workspace) });
    const codeDigest = requireTool(tools, "code_digest");

    const result = await codeDigest.execute(
      "tc-code-digest",
      { paths: [workspace], query: "run", max_tokens: 400, limit: 5 },
      undefined,
      undefined,
      fakeContext("source-intelligence-digest"),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("[CodeDigest]");
    expect(text).toContain("tool.py");
    expect(text).toContain("function run");
    const display = result as {
      display?: { summaryText?: string; detailsText?: string; rawText?: string };
    };
    const displayPayload = requireDefined(display.display, "Expected code_digest display payload.");
    expect(displayPayload.summaryText).toContain("[CodeDigest]");
    expect(displayPayload.summaryText).toContain("budget_tokens: 400");
    expect(Object.keys(displayPayload).toSorted()).toEqual(["summaryText"]);
    const details = toolOutcomePayload(result) as {
      budget?: { estimator?: string; maxTokens?: number; renderedTokens?: number };
    };
    expect(details.budget?.estimator).toBe("@brewva/brewva-token-estimation");
    expect(details.budget?.renderedTokens).toBe(
      estimateTokenCount(text, { encoding: "o200k_base" }),
    );
    expect(details.budget?.renderedTokens ?? Infinity).toBeLessThanOrEqual(
      details.budget?.maxTokens ?? 0,
    );
  });

  test("code_digest path rejection includes the rejected path and recovery guidance", async () => {
    const workspace = realpathSync(makeWorkspace());
    const outsideRoot = realpathSync(mkdtempSync(join(tmpdir(), "brewva-code-outside-")));
    const tools = createSourceIntelligenceTools({ runtime: runtimeFor(workspace) });
    const codeDigest = requireTool(tools, "code_digest");

    const result = await codeDigest.execute(
      "tc-code-digest-path-rejection",
      { paths: [outsideRoot], max_tokens: 400, limit: 5 },
      undefined,
      undefined,
      fakeContext("source-intelligence-path-rejection"),
    );

    expect(result.outcome.kind).toBe("err");
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain(`code_digest rejected: path escapes target roots (${workspace}).`);
    expect(text).toContain(`Rejected path: ${outsideRoot}`);
    expect(text).toContain("Stay inside a target root");
  });

  test("code_digest bounds root parsing to selected digest files", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-code-digest-bounded-"));
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src/a.ts"), "export function alpha() { return 1; }\n", "utf8");
    const unreadablePath = join(workspace, "src/z.ts");
    writeFileSync(unreadablePath, "export function zeta() { return 2; }\n", "utf8");
    chmodSync(unreadablePath, 0o000);

    try {
      const tools = createSourceIntelligenceTools({ runtime: runtimeFor(workspace) });
      const codeDigest = requireTool(tools, "code_digest");

      const result = await codeDigest.execute(
        "tc-code-digest-bounded",
        { paths: [workspace], max_tokens: 400, limit: 1 },
        undefined,
        undefined,
        fakeContext("source-intelligence-digest-bounded"),
      );

      const text = extractTextContent(
        result as { content: Array<{ type: string; text?: string }> },
      );
      expect(text).toContain("[CodeDigest]");
      expect(text).toContain("src/a.ts");
      expect(text).not.toContain("src/z.ts");
      expect((toolOutcomePayload(result) as { omitted?: { files?: number } }).omitted?.files).toBe(
        1,
      );
    } finally {
      chmodSync(unreadablePath, 0o600);
    }
  });

  test("code_digest prioritizes workspace package manifests before source file overflow", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-code-digest-manifests-"));
    mkdirSync(join(workspace, "packages/alpha/src"), { recursive: true });
    mkdirSync(join(workspace, "packages/gateway"), { recursive: true });
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ name: "root", workspaces: ["packages/*"] }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(workspace, "packages/alpha/package.json"),
      JSON.stringify({ name: "@fixture/alpha" }, null, 2),
      "utf8",
    );
    for (let index = 0; index < 32; index += 1) {
      writeFileSync(
        join(workspace, "packages/alpha/src", `file-${String(index).padStart(2, "0")}.ts`),
        `export const value${index} = ${index};\n`,
        "utf8",
      );
    }
    writeFileSync(
      join(workspace, "packages/gateway/package.json"),
      JSON.stringify(
        {
          name: "@fixture/gateway",
          exports: {
            ".": {
              bun: "./src/index.ts",
            },
            "./hosted": {
              bun: "./src/hosted/api.ts",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const tools = createSourceIntelligenceTools({ runtime: runtimeFor(workspace) });
    const codeDigest = requireTool(tools, "code_digest");

    const result = await codeDigest.execute(
      "tc-code-digest-package-manifest-priority",
      { paths: [workspace], max_tokens: 800, limit: 4 },
      undefined,
      undefined,
      fakeContext("source-intelligence-digest-manifest-priority"),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("packages/gateway/package.json");
    expect(text).toContain("module @fixture/gateway");
    expect(text).toContain("./src/hosted/api.ts");
  });

  test("code_digest honors an already aborted signal before scanning", async () => {
    const workspace = makeWorkspace();
    const tools = createSourceIntelligenceTools({ runtime: runtimeFor(workspace) });
    const codeDigest = requireTool(tools, "code_digest");
    const controller = new AbortController();
    controller.abort();

    const result = await codeDigest.execute(
      "tc-code-digest-aborted",
      { paths: [workspace], max_tokens: 400, limit: 5 },
      controller.signal,
      undefined,
      fakeContext("source-intelligence-digest-aborted"),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("source_intelligence_aborted");
    expect(result.outcome.kind).toBe("err");
  });

  test("code_deps and code_callers expose graph confidence without edit authority", async () => {
    const workspace = makeWorkspace();
    const tools = createSourceIntelligenceTools({ runtime: runtimeFor(workspace) });
    const codeDeps = requireTool(tools, "code_deps");
    const codeCallers = requireTool(tools, "code_callers");
    const codeCallees = requireTool(tools, "code_callees");

    const depsResult = await codeDeps.execute(
      "tc-code-deps",
      { paths: [join(workspace, "src")] },
      undefined,
      undefined,
      fakeContext("source-intelligence-deps"),
    );
    expect(
      extractTextContent(depsResult as { content: Array<{ type: string; text?: string }> }),
    ).toContain("./helper");

    const callersResult = await codeCallers.execute(
      "tc-code-callers",
      { symbol: "helper", file_path: join(workspace, "src/helper.ts"), max_edges: 1 },
      undefined,
      undefined,
      fakeContext("source-intelligence-callers"),
    );
    const details = toolOutcomePayload(callersResult) as {
      edges?: Array<{ confidence?: string; editAuthority?: boolean }>;
      omittedEdges?: number;
    };
    expect(details.edges?.length).toBe(1);
    expect(details.omittedEdges ?? 0).toBeGreaterThan(0);
    expect(details.edges?.some((edge) => edge.confidence === "exact")).toBe(true);
    expect(details.edges?.every((edge) => edge.editAuthority === false)).toBe(true);

    const ambiguousResult = await codeCallers.execute(
      "tc-code-callers-ambiguous",
      { symbol: "helper", file_path: join(workspace, "src/helper.ts"), max_edges: 10 },
      undefined,
      undefined,
      fakeContext("source-intelligence-callers-ambiguous"),
    );
    const ambiguousDetails = toolOutcomePayload(ambiguousResult) as {
      edges?: Array<{ fromPath?: string; confidence?: string }>;
    };
    expect(
      ambiguousDetails.edges?.some(
        (edge) => edge.fromPath?.endsWith("src/loose.ts") && edge.confidence === "ambiguous",
      ),
    ).toBe(true);

    const calleesResult = await codeCallees.execute(
      "tc-code-callees",
      { symbol: "start", file_path: join(workspace, "src/index.ts") },
      undefined,
      undefined,
      fakeContext("source-intelligence-callees"),
    );
    const calleesDetails = toolOutcomePayload(calleesResult) as {
      edges?: Array<{ rawSpecifier?: string; editAuthority?: boolean }>;
    };
    expect(calleesDetails.edges?.some((edge) => edge.rawSpecifier === "helper")).toBe(true);
    expect(calleesDetails.edges?.every((edge) => edge.editAuthority === false)).toBe(true);
  });

  test("code_surface reports true re-exports and code_outline fails closed on unsupported files", async () => {
    const workspace = makeWorkspace();
    const tools = createSourceIntelligenceTools({ runtime: runtimeFor(workspace) });
    const codeSurface = requireTool(tools, "code_surface");
    const codeOutline = requireTool(tools, "code_outline");

    const surfaceResult = await codeSurface.execute(
      "tc-code-surface",
      { path: join(workspace, "src/barrel.ts") },
      undefined,
      undefined,
      fakeContext("source-intelligence-surface"),
    );
    const surfaceText = extractTextContent(
      surfaceResult as { content: Array<{ type: string; text?: string }> },
    );
    expect(surfaceText).toContain("./helper");
    expect(surfaceText).toContain("./index");
    expect(surfaceText).toContain("function exportedHelper");

    const packageSurfaceResult = await codeSurface.execute(
      "tc-code-surface-package",
      { path: workspace },
      undefined,
      undefined,
      fakeContext("source-intelligence-surface-package"),
    );
    const packageSurfaceText = extractTextContent(
      packageSurfaceResult as { content: Array<{ type: string; text?: string }> },
    );
    expect(packageSurfaceText).toContain("function exportedHelper");
    expect(packageSurfaceText).toContain("function main");
    expect(packageSurfaceText).not.toContain("internalOnly");

    const unsupportedResult = await codeOutline.execute(
      "tc-code-outline-unsupported",
      { file_path: join(workspace, "README.md") },
      undefined,
      undefined,
      fakeContext("source-intelligence-unsupported"),
    );
    expect(unsupportedResult.outcome.kind).toBe("err");
    expect(
      extractTextContent(unsupportedResult as { content: Array<{ type: string; text?: string }> }),
    ).toContain("Unsupported source language");
  });
});
