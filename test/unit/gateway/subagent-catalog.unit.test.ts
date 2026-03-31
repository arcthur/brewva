import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadHostedDelegationCatalog,
  resolveHostedExecutionEnvelope,
} from "../../../packages/brewva-gateway/src/subagents/catalog.js";

describe("subagent delegation catalog", () => {
  test("exposes built-in review lane delegates on the canonical reviewer envelope", async () => {
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
        envelope: "readonly-reviewer",
        fallbackResultMode: "review",
      });
    }
  });

  test("loads workspace execution envelopes and agent specs", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-subagent-catalog-"));
    const subagentDir = join(workspace, ".brewva", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      join(subagentDir, "tight-reviewer.json"),
      JSON.stringify(
        {
          kind: "envelope",
          name: "tight-reviewer",
          extends: "readonly-reviewer",
          description: "Workspace-specific narrowed reviewer envelope",
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
          description: "Security review worker",
          skillName: "review",
          envelope: "tight-reviewer",
          fallbackResultMode: "review",
          executorPreamble: "Operate as a security-focused reviewer.",
        },
        null,
        2,
      ),
      "utf8",
    );

    const catalog = await loadHostedDelegationCatalog(workspace);
    const envelope = resolveHostedExecutionEnvelope(catalog, "tight-reviewer");
    const agentSpec = catalog.agentSpecs.get("security-review");

    expect(envelope).toBeDefined();
    expect(envelope?.managedToolNames).toEqual(["grep", "read_spans"]);
    expect(catalog.workspaceEnvelopeNames.has("tight-reviewer")).toBe(true);
    expect(agentSpec).toEqual({
      name: "security-review",
      description: "Security review worker",
      skillName: "review",
      envelope: "tight-reviewer",
      fallbackResultMode: "review",
      executorPreamble: "Operate as a security-focused reviewer.",
    });
    expect(catalog.workspaceAgentSpecNames.has("security-review")).toBe(true);
  });

  test("rejects workspace envelopes that widen a base envelope", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-subagent-catalog-widen-envelope-"));
    const subagentDir = join(workspace, ".brewva", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      join(subagentDir, "readonly-reviewer.json"),
      JSON.stringify(
        {
          kind: "envelope",
          name: "readonly-reviewer",
          description: "Invalid widened reviewer envelope",
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
        "invalid_execution_envelope:readonly-reviewer:boundary cannot widen beyond the base envelope",
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
          envelope: "readonly-reviewer",
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
      join(subagentDir, "review.json"),
      JSON.stringify(
        {
          kind: "agentSpec",
          name: "review",
          description: "Invalid widened review worker",
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
        "invalid_agent_spec:review:envelope:boundary cannot widen beyond the base envelope",
      );
    }
  });

  test("loads Markdown-authored agent overlays from .brewva/agents", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-subagent-agent-markdown-"));
    const agentDir = join(workspace, ".brewva", "agents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "review.md"),
      [
        "---",
        "extends: review",
        "description: Workspace review delegate",
        "envelope: readonly-reviewer",
        "---",
        "Focus on rollback posture, governance boundaries, and operator-facing regressions.",
      ].join("\n"),
      "utf8",
    );

    const catalog = await loadHostedDelegationCatalog(workspace);
    const agentSpec = catalog.agentSpecs.get("review");

    expect(agentSpec).toMatchObject({
      name: "review",
      description: "Workspace review delegate",
      envelope: "readonly-reviewer",
      skillName: "review",
      fallbackResultMode: "review",
      executorPreamble:
        "Operate as a strict read-only reviewer. Keep findings concrete, high-signal, and evidence-backed.",
      instructionsMarkdown:
        "Focus on rollback posture, governance boundaries, and operator-facing regressions.",
    });
    expect(catalog.workspaceAgentSpecNames.has("review")).toBe(true);
  });

  test("loads Markdown-authored agent overlays from .config/brewva/agents", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-subagent-agent-config-root-"));
    const configAgentDir = join(workspace, ".config", "brewva", "agents");
    mkdirSync(configAgentDir, { recursive: true });
    writeFileSync(
      join(configAgentDir, "ops-review.md"),
      [
        "---",
        "extends: review",
        "description: Config-root review delegate",
        "envelope: readonly-reviewer",
        "---",
        "Focus on config-managed governance checks.",
      ].join("\n"),
      "utf8",
    );

    const catalog = await loadHostedDelegationCatalog(workspace);
    expect(catalog.agentSpecs.get("ops-review")).toMatchObject({
      name: "ops-review",
      description: "Config-root review delegate",
      envelope: "readonly-reviewer",
      skillName: "review",
      fallbackResultMode: "review",
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
        "extends: review",
        "description: Windows-authored review delegate",
        "envelope: readonly-reviewer",
        "---",
        "Focus on durable operator-facing regressions.",
      ].join("\r\n"),
      "utf8",
    );

    const catalog = await loadHostedDelegationCatalog(workspace);
    expect(catalog.agentSpecs.get("reviewer")).toMatchObject({
      name: "reviewer",
      description: "Windows-authored review delegate",
      envelope: "readonly-reviewer",
      instructionsMarkdown: "Focus on durable operator-facing regressions.",
    });
  });
});
