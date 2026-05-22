import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokenCount } from "@brewva/brewva-token-estimation";
import { buildBrewvaTools } from "@brewva/brewva-tools";
import type { BrewvaBundledToolRuntime } from "@brewva/brewva-tools/contracts";
import { createSourceIntelligenceTools } from "@brewva/brewva-tools/navigation";
import { requireDefined } from "../../helpers/assertions.js";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";
import { createBundledToolRuntime } from "../../helpers/runtime.js";
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

  test("code_outline returns language-neutral outline details and records source intelligence telemetry", async () => {
    const workspace = makeWorkspace();
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
    const tools = createSourceIntelligenceTools({ runtime: createBundledToolRuntime(runtime) });
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
    expect(
      (result as { details?: { declarationsCount?: number } }).details?.declarationsCount,
    ).toBe(3);
    expect(
      runtime.capabilities.events.records.query("source-intelligence-outline", {
        type: "tool_source_intelligence",
      }).length,
    ).toBeGreaterThan(0);
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
    const details = result as {
      details?: { budget?: { estimator?: string; maxTokens?: number; renderedTokens?: number } };
    };
    expect(details.details?.budget?.estimator).toBe("@brewva/brewva-token-estimation");
    expect(details.details?.budget?.renderedTokens).toBe(
      estimateTokenCount(text, { encoding: "o200k_base" }),
    );
    expect(details.details?.budget?.renderedTokens ?? Infinity).toBeLessThanOrEqual(
      details.details?.budget?.maxTokens ?? 0,
    );
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
    const details = callersResult as {
      details?: {
        edges?: Array<{ confidence?: string; editAuthority?: boolean }>;
        omittedEdges?: number;
      };
    };
    expect(details.details?.edges?.length).toBe(1);
    expect(details.details?.omittedEdges ?? 0).toBeGreaterThan(0);
    expect(details.details?.edges?.some((edge) => edge.confidence === "exact")).toBe(true);
    expect(details.details?.edges?.every((edge) => edge.editAuthority === false)).toBe(true);

    const ambiguousResult = await codeCallers.execute(
      "tc-code-callers-ambiguous",
      { symbol: "helper", file_path: join(workspace, "src/helper.ts"), max_edges: 10 },
      undefined,
      undefined,
      fakeContext("source-intelligence-callers-ambiguous"),
    );
    const ambiguousDetails = ambiguousResult as {
      details?: { edges?: Array<{ fromPath?: string; confidence?: string }> };
    };
    expect(
      ambiguousDetails.details?.edges?.some(
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
    const calleesDetails = calleesResult as {
      details?: { edges?: Array<{ rawSpecifier?: string; editAuthority?: boolean }> };
    };
    expect(calleesDetails.details?.edges?.some((edge) => edge.rawSpecifier === "helper")).toBe(
      true,
    );
    expect(calleesDetails.details?.edges?.every((edge) => edge.editAuthority === false)).toBe(true);
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
    expect((unsupportedResult as { details?: { verdict?: string } }).details?.verdict).toBe("fail");
    expect(
      extractTextContent(unsupportedResult as { content: Array<{ type: string; text?: string }> }),
    ).toContain("Unsupported source language");
  });
});
