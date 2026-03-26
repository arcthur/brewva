import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadHostedDelegationCatalog,
  resolveHostedExecutionEnvelope,
} from "../../../packages/brewva-gateway/src/subagents/catalog.js";

describe("subagent delegation catalog", () => {
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
});
