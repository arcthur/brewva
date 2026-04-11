import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadHostedDelegationCatalog,
  resolveHostedExecutionEnvelope,
} from "../../../packages/brewva-gateway/src/subagents/catalog.js";

describe("subagent delegation catalog", () => {
  test("promotes the built-in advisor delegate to the canonical consult result mode", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());

    expect(catalog.agentSpecs.get("advisor")).toMatchObject({
      name: "advisor",
      envelope: "readonly-advisor",
      fallbackResultMode: "consult",
    });
  });

  test("exposes built-in review lane delegates on the canonical advisor envelope", async () => {
    const catalog = await loadHostedDelegationCatalog(process.cwd());

    for (const agentSpecName of [
      "review-correctness",
      "review-boundaries",
      "review-operability",
      "review-security",
      "review-concurrency",
      "review-compatibility",
      "review-performance",
    ]) {
      expect(catalog.agentSpecs.get(agentSpecName)).toMatchObject({
        name: agentSpecName,
        envelope: "readonly-advisor",
        fallbackResultMode: "consult",
        defaultConsultKind: "review",
      });
    }

    expect(catalog.agentSpecs.get("review-operability")).toMatchObject({
      instructionsMarkdown: expect.stringContaining("Recognize your own rationalizations"),
    });
  });

  test("loads workspace execution envelopes and agent specs", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-subagent-catalog-"));
    const subagentDir = join(workspace, ".brewva", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      join(subagentDir, "tight-advisor.json"),
      JSON.stringify(
        {
          kind: "envelope",
          name: "tight-advisor",
          extends: "readonly-advisor",
          description: "Workspace-specific narrowed advisor envelope",
          managedToolNames: ["grep", "read_spans"],
          defaultContextBudget: {
            maxTurnTokens: 2200,
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    writeFileSync(
      join(subagentDir, "security-review.json"),
      JSON.stringify(
        {
          kind: "agentSpec",
          name: "security-review",
          description: "Security review advisor",
          envelope: "tight-advisor",
          fallbackResultMode: "consult",
          defaultConsultKind: "review",
          executorPreamble: "Operate as a security-focused advisor.",
        },
        null,
        2,
      ),
      "utf8",
    );

    const catalog = await loadHostedDelegationCatalog(workspace);
    const envelope = resolveHostedExecutionEnvelope(catalog, "tight-advisor");
    const agentSpec = catalog.agentSpecs.get("security-review");

    expect(envelope).toBeDefined();
    expect(envelope?.managedToolNames).toEqual(["grep", "read_spans"]);
    expect(catalog.workspaceEnvelopeNames.has("tight-advisor")).toBe(true);
    expect(agentSpec).toEqual({
      name: "security-review",
      description: "Security review advisor",
      envelope: "tight-advisor",
      fallbackResultMode: "consult",
      defaultConsultKind: "review",
      executorPreamble: "Operate as a security-focused advisor.",
    });
    expect(catalog.workspaceAgentSpecNames.has("security-review")).toBe(true);
  });

  test("accepts explicit consult result mode in workspace agent specs", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-subagent-catalog-consult-agent-"));
    const subagentDir = join(workspace, ".brewva", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      join(subagentDir, "bounded-advisor.json"),
      JSON.stringify(
        {
          kind: "agentSpec",
          name: "bounded-advisor",
          description: "Workspace-specific design advisor",
          envelope: "readonly-advisor",
          fallbackResultMode: "consult",
          defaultConsultKind: "design",
          executorPreamble: "Operate as a bounded advisor.",
        },
        null,
        2,
      ),
      "utf8",
    );

    const catalog = await loadHostedDelegationCatalog(workspace);

    expect(catalog.agentSpecs.get("bounded-advisor")).toEqual({
      name: "bounded-advisor",
      description: "Workspace-specific design advisor",
      envelope: "readonly-advisor",
      fallbackResultMode: "consult",
      defaultConsultKind: "design",
      executorPreamble: "Operate as a bounded advisor.",
    });
    expect(catalog.workspaceAgentSpecNames.has("bounded-advisor")).toBe(true);
  });

  test("loads workspace subagent JSONC overlays with comments and trailing commas", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-subagent-catalog-jsonc-"));
    const subagentDir = join(workspace, ".brewva", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      join(subagentDir, "jsonc-advisor.json"),
      [
        "{",
        "  // jsonc-authored workspace advisor delegate",
        '  "kind": "agentSpec",',
        '  "name": "jsonc-advisor",',
        '  "description": "Workspace JSONC advisor worker",',
        '  "envelope": "readonly-advisor",',
        '  "fallbackResultMode": "consult",',
        '  "defaultConsultKind": "review",',
        '  "executorPreamble": "Operate from JSONC-authored config.",',
        "}",
      ].join("\n"),
      "utf8",
    );

    const catalog = await loadHostedDelegationCatalog(workspace);

    expect(catalog.agentSpecs.get("jsonc-advisor")).toEqual({
      name: "jsonc-advisor",
      description: "Workspace JSONC advisor worker",
      envelope: "readonly-advisor",
      fallbackResultMode: "consult",
      defaultConsultKind: "review",
      executorPreamble: "Operate from JSONC-authored config.",
    });
    expect(catalog.workspaceAgentSpecNames.has("jsonc-advisor")).toBe(true);
  });

  test("rejects workspace envelopes that widen a base envelope", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-subagent-catalog-widen-envelope-"));
    const subagentDir = join(workspace, ".brewva", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      join(subagentDir, "readonly-advisor.json"),
      JSON.stringify(
        {
          kind: "envelope",
          name: "readonly-advisor",
          description: "Invalid widened advisor envelope",
          boundary: "effectful",
        },
        null,
        2,
      ),
      "utf8",
    );

    try {
      await loadHostedDelegationCatalog(workspace);
      throw new Error("expected loadHostedDelegationCatalog to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "invalid_execution_envelope:readonly-advisor:boundary cannot widen beyond the base envelope",
      );
    }
  });

  test("rejects legacy workspace subagent kind aliases", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-subagent-catalog-legacy-kind-"));
    const subagentDir = join(workspace, ".brewva", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      join(subagentDir, "legacy-review.json"),
      JSON.stringify(
        {
          kind: "agent-spec",
          name: "legacy-review",
          description: "Legacy alias should be rejected",
          envelope: "readonly-advisor",
        },
        null,
        2,
      ),
      "utf8",
    );

    try {
      await loadHostedDelegationCatalog(workspace);
      throw new Error("expected loadHostedDelegationCatalog to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "invalid_subagent_config:legacy-review.json:unknown kind 'agent-spec'",
      );
    }
  });

  test("rejects legacy envelope aliases in workspace overlays", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-subagent-catalog-legacy-envelope-"));
    const subagentDir = join(workspace, ".brewva", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      join(subagentDir, "tight-scout.json"),
      JSON.stringify(
        {
          kind: "envelope",
          name: "tight-scout",
          extends: "explore",
          description: "Legacy alias should not resolve as an envelope base",
        },
        null,
        2,
      ),
      "utf8",
    );

    try {
      await loadHostedDelegationCatalog(workspace);
      throw new Error("expected loadHostedDelegationCatalog to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "invalid_execution_envelope:tight-scout.json:unknown base 'explore'",
      );
    }
  });

  test("rejects agent specs that widen their base envelope", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-subagent-catalog-widen-agent-"));
    const subagentDir = join(workspace, ".brewva", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      join(subagentDir, "advisor.json"),
      JSON.stringify(
        {
          kind: "agentSpec",
          name: "advisor",
          description: "Invalid widened advisor worker",
          envelope: "patch-worker",
        },
        null,
        2,
      ),
      "utf8",
    );

    try {
      await loadHostedDelegationCatalog(workspace);
      throw new Error("expected loadHostedDelegationCatalog to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "invalid_agent_spec:advisor:envelope:boundary cannot widen beyond the base envelope",
      );
    }
  });

  test("loads Markdown-authored agent overlays from .brewva/agents", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-subagent-agent-markdown-"));
    const agentDir = join(workspace, ".brewva", "agents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "advisor.md"),
      [
        "---",
        "extends: advisor",
        "description: Workspace advisor delegate",
        "envelope: readonly-advisor",
        "---",
        "Focus on rollback posture, governance boundaries, and operator-facing regressions.",
      ].join("\n"),
      "utf8",
    );

    const catalog = await loadHostedDelegationCatalog(workspace);
    const agentSpec = catalog.agentSpecs.get("advisor");

    expect(agentSpec).toMatchObject({
      name: "advisor",
      description: "Workspace advisor delegate",
      envelope: "readonly-advisor",
      fallbackResultMode: "consult",
      executorPreamble:
        "Operate as a read-only advisor. Reduce uncertainty, keep evidence concrete, and optimize for the parent's next decision.",
      instructionsMarkdown:
        "Focus on rollback posture, governance boundaries, and operator-facing regressions.",
    });
    expect(catalog.workspaceAgentSpecNames.has("advisor")).toBe(true);
  });

  test("loads Markdown-authored agent overlays from .config/brewva/agents", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-subagent-agent-config-root-"));
    const configAgentDir = join(workspace, ".config", "brewva", "agents");
    mkdirSync(configAgentDir, { recursive: true });
    writeFileSync(
      join(configAgentDir, "ops-review.md"),
      [
        "---",
        "extends: advisor",
        "description: Config-root advisor delegate",
        "envelope: readonly-advisor",
        "---",
        "Focus on config-managed governance checks.",
      ].join("\n"),
      "utf8",
    );

    const catalog = await loadHostedDelegationCatalog(workspace);
    expect(catalog.agentSpecs.get("ops-review")).toMatchObject({
      name: "ops-review",
      description: "Config-root advisor delegate",
      envelope: "readonly-advisor",
      fallbackResultMode: "consult",
      instructionsMarkdown: "Focus on config-managed governance checks.",
    });
    expect(catalog.workspaceAgentSpecNames.has("ops-review")).toBe(true);
  });

  test("parses Markdown-authored agent overlays with CRLF frontmatter", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-subagent-agent-markdown-crlf-"));
    const agentDir = join(workspace, ".brewva", "agents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "reviewer.md"),
      [
        "---",
        "extends: advisor",
        "description: Windows-authored advisor delegate",
        "envelope: readonly-advisor",
        "---",
        "Focus on durable operator-facing regressions.",
      ].join("\r\n"),
      "utf8",
    );

    const catalog = await loadHostedDelegationCatalog(workspace);
    expect(catalog.agentSpecs.get("reviewer")).toMatchObject({
      name: "reviewer",
      description: "Windows-authored advisor delegate",
      envelope: "readonly-advisor",
      instructionsMarkdown: "Focus on durable operator-facing regressions.",
    });
  });

  test("rejects Markdown-authored agent overlays with malformed frontmatter", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-subagent-agent-markdown-invalid-"));
    const agentDir = join(workspace, ".brewva", "agents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "reviewer.md"),
      ["---", "description: [unterminated", "---", "Focus on durable regressions."].join("\n"),
      "utf8",
    );

    try {
      await loadHostedDelegationCatalog(workspace);
      throw new Error("expected loadHostedDelegationCatalog to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("invalid_subagent_config:reviewer.md");
      expect((error as Error).message).toContain("invalid frontmatter");
    }
  });
});
