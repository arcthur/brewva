import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createOutputSearchTool } from "@brewva/brewva-tools";
import { extractTextContent, mergeContext } from "./tools-flow.helpers.js";

describe("output_search contract", () => {
  test("finds snippets from persisted artifacts", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-output-search-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s12-output-search";

    const artifactRef = ".orchestrator/tool-output-artifacts/session-a/100-exec-call.txt";
    const artifactDir = join(workspace, ".orchestrator/tool-output-artifacts/session-a");
    mkdirSync(artifactDir, { recursive: true });
    const artifactText = [
      "build started",
      "WARN network jitter detected",
      "ERROR connection refused to postgres at 127.0.0.1:5432",
      "retry 3/3 failed",
    ].join("\n");
    writeFileSync(join(workspace, artifactRef), artifactText, "utf8");

    runtime.events.record({
      sessionId,
      type: "tool_output_artifact_persisted",
      payload: {
        toolName: "exec",
        artifactRef,
        rawBytes: Buffer.byteLength(artifactText, "utf8"),
      } as Record<string, unknown>,
    });

    const tool = createOutputSearchTool({ runtime });
    const result = await tool.execute(
      "tc-output-search",
      {
        query: "connection refused postgres",
        limit: 1,
      },
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );

    const text = extractTextContent(result);
    expect(text).toContain("[OutputSearch]");
    expect(text).toContain("Match layer: exact");
    expect(text.toLowerCase()).toContain("connection refused");
    expect(text).toContain("tool=exec");
    expect(text).toContain("ref=.orchestrator/tool-output-artifacts/session-a/100-exec-call.txt");
  });

  test("falls back to fuzzy matching for typo queries", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-output-search-fuzzy-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s12-output-search-fuzzy";

    const artifactRef = ".orchestrator/tool-output-artifacts/session-b/101-exec-call.txt";
    const artifactDir = join(workspace, ".orchestrator/tool-output-artifacts/session-b");
    mkdirSync(artifactDir, { recursive: true });
    const artifactText = [
      "pipeline bootstrap complete",
      "authentication middleware initialized",
      "token exchange validated",
    ].join("\n");
    writeFileSync(join(workspace, artifactRef), artifactText, "utf8");

    runtime.events.record({
      sessionId,
      type: "tool_output_artifact_persisted",
      payload: {
        toolName: "exec",
        artifactRef,
        rawBytes: Buffer.byteLength(artifactText, "utf8"),
      } as Record<string, unknown>,
    });

    const tool = createOutputSearchTool({ runtime });
    const result = await tool.execute(
      "tc-output-search-fuzzy",
      {
        query: "authentcation",
        limit: 2,
      },
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );

    const text = extractTextContent(result);
    expect(text).toContain("[OutputSearch]");
    expect(text).toContain("Match layer: fuzzy");
    expect(text.toLowerCase()).toContain("authentication middleware");
  });

  test("uses partial layer for prefix-heavy queries", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-output-search-partial-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s12-output-search-partial";

    const artifactRef = ".orchestrator/tool-output-artifacts/session-p/101-exec-call.txt";
    const artifactDir = join(workspace, ".orchestrator/tool-output-artifacts/session-p");
    mkdirSync(artifactDir, { recursive: true });
    const artifactText = [
      "pipeline bootstrap complete",
      "authentication middleware initialized",
      "token exchange validated",
    ].join("\n");
    writeFileSync(join(workspace, artifactRef), artifactText, "utf8");

    runtime.events.record({
      sessionId,
      type: "tool_output_artifact_persisted",
      payload: {
        toolName: "exec",
        artifactRef,
        rawBytes: Buffer.byteLength(artifactText, "utf8"),
      } as Record<string, unknown>,
    });

    const tool = createOutputSearchTool({ runtime });
    const result = await tool.execute(
      "tc-output-search-partial",
      {
        query: "middlware init",
        limit: 2,
      },
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );

    const text = extractTextContent(result);
    expect(text).toContain("[OutputSearch]");
    expect(text).toContain("Match layer: partial");
    expect(text.toLowerCase()).toContain("authentication middleware initialized");
  });

  test("suppresses low-confidence fuzzy matches", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-output-search-fuzzy-gate-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s12-output-search-fuzzy-gate";

    const artifactRef = ".orchestrator/tool-output-artifacts/session-g/101-exec-call.txt";
    const artifactDir = join(workspace, ".orchestrator/tool-output-artifacts/session-g");
    mkdirSync(artifactDir, { recursive: true });
    const artifactText = [
      "pipeline bootstrap complete",
      "authentication middleware initialized",
      "token exchange validated",
    ].join("\n");
    writeFileSync(join(workspace, artifactRef), artifactText, "utf8");

    runtime.events.record({
      sessionId,
      type: "tool_output_artifact_persisted",
      payload: {
        toolName: "exec",
        artifactRef,
        rawBytes: Buffer.byteLength(artifactText, "utf8"),
      } as Record<string, unknown>,
    });

    const tool = createOutputSearchTool({ runtime });
    const result = await tool.execute(
      "tc-output-search-fuzzy-gate",
      {
        query: "authentxxation",
        limit: 2,
      },
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );

    const text = extractTextContent(result);
    expect(text).toContain("[OutputSearch]");
    expect(text).toContain("No matches found across exact/partial/fuzzy layers.");
  });

  test("throttles repeated single-query calls", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-output-search-throttle-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s12-output-search-throttle";
    const artifactDir = join(workspace, ".orchestrator/tool-output-artifacts/session-c");
    mkdirSync(artifactDir, { recursive: true });

    const artifacts = [
      {
        ref: ".orchestrator/tool-output-artifacts/session-c/201-exec-call.txt",
        text: "ERROR timeout while connecting to gateway",
      },
      {
        ref: ".orchestrator/tool-output-artifacts/session-c/202-exec-call.txt",
        text: "timeout retry budget exhausted on upstream",
      },
    ];

    for (const artifact of artifacts) {
      writeFileSync(join(workspace, artifact.ref), artifact.text, "utf8");
      runtime.events.record({
        sessionId,
        type: "tool_output_artifact_persisted",
        payload: {
          toolName: "exec",
          artifactRef: artifact.ref,
          rawBytes: Buffer.byteLength(artifact.text, "utf8"),
        } as Record<string, unknown>,
      });
    }

    const tool = createOutputSearchTool({ runtime });
    for (let call = 0; call < 4; call += 1) {
      const result = await tool.execute(
        `tc-output-search-throttle-normal-${call}`,
        { query: "timeout", limit: 2 },
        undefined,
        undefined,
        mergeContext(sessionId, { cwd: workspace }),
      );
      expect(extractTextContent(result)).toContain("Throttle: normal");
    }

    const limited = await tool.execute(
      "tc-output-search-throttle-limited",
      { query: "timeout", limit: 2 },
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );
    const limitedText = extractTextContent(limited);
    expect(limitedText).toContain("Throttle: limited");
    expect(limitedText).toContain("Result limit: 1/2");
    expect(limitedText).toContain("[Throttle]");

    for (let call = 0; call < 5; call += 1) {
      await tool.execute(
        `tc-output-search-throttle-more-${call}`,
        { query: "timeout", limit: 2 },
        undefined,
        undefined,
        mergeContext(sessionId, { cwd: workspace }),
      );
    }

    const blocked = await tool.execute(
      "tc-output-search-throttle-blocked",
      { query: "timeout", limit: 2 },
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );
    const blockedText = extractTextContent(blocked);
    expect(blockedText).toContain("Blocked due to high-frequency single-query search calls.");
    expect((blocked.details as { verdict?: string } | undefined)?.verdict).toBe("inconclusive");
  });

  test("reuses cache and invalidates on artifact change", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-output-search-cache-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s12-output-search-cache";

    const artifactRef = ".orchestrator/tool-output-artifacts/session-d/301-exec-call.txt";
    const artifactDir = join(workspace, ".orchestrator/tool-output-artifacts/session-d");
    mkdirSync(artifactDir, { recursive: true });

    let artifactText = "cache marker alpha";
    writeFileSync(join(workspace, artifactRef), artifactText, "utf8");
    runtime.events.record({
      sessionId,
      type: "tool_output_artifact_persisted",
      payload: {
        toolName: "exec",
        artifactRef,
        rawBytes: Buffer.byteLength(artifactText, "utf8"),
      } as Record<string, unknown>,
    });

    const tool = createOutputSearchTool({ runtime });
    const first = await tool.execute(
      "tc-output-search-cache-first",
      { query: "marker alpha", limit: 2 },
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );
    const firstText = extractTextContent(first);
    expect(firstText).toContain("cache marker alpha");
    expect(firstText).toContain("Cache hits/misses: 0/1");

    const second = await tool.execute(
      "tc-output-search-cache-second",
      { query: "marker alpha", limit: 2 },
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );
    const secondText = extractTextContent(second);
    expect(secondText).toContain("Cache hits/misses: 1/0");

    artifactText = "cache marker beta with updated payload";
    writeFileSync(join(workspace, artifactRef), artifactText, "utf8");
    runtime.events.record({
      sessionId,
      type: "tool_output_artifact_persisted",
      payload: {
        toolName: "exec",
        artifactRef,
        rawBytes: Buffer.byteLength(artifactText, "utf8"),
      } as Record<string, unknown>,
    });

    const third = await tool.execute(
      "tc-output-search-cache-third",
      { query: "marker beta updated", limit: 2 },
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );
    const thirdText = extractTextContent(third);
    expect(thirdText).toContain("cache marker beta with updated payload");
    expect(thirdText).toContain("Cache hits/misses: 0/1");
  });
});
