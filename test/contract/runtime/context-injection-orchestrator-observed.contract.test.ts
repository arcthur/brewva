import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { createTestWorkspace } from "../../helpers/workspace.js";

function writeIdentity(workspace: string, agentId: string, content: string): void {
  const path = join(workspace, ".brewva", "agents", agentId, "identity.md");
  mkdirSync(join(workspace, ".brewva", "agents", agentId), { recursive: true });
  writeFileSync(path, `${content.trim()}\n`, "utf8");
}

function writeAgentsRules(workspace: string): void {
  writeFileSync(
    join(workspace, "AGENTS.md"),
    [
      "## CRITICAL RULES",
      "- User-facing command name is `brewva`.",
      "- Use workspace package imports `@brewva/brewva-runtime`.",
      "- Use Bun `1.3.9`.",
      "- Run bun run test:dist.",
    ].join("\n"),
    "utf8",
  );
}

describe("Context injection orchestrator characterization", () => {
  test("registers semantic sources and emits context_injected event", async () => {
    const workspace = createTestWorkspace("ctx-orchestrator-sources");
    writeIdentity(
      workspace,
      "default",
      ["## Who I Am", "orchestrator characterization"].join("\n"),
    );
    writeAgentsRules(workspace);
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);

    const runtime = new BrewvaRuntime({ cwd: workspace, agentId: "default", config });
    const sessionId = "ctx-orchestrator-sources-1";
    runtime.context.onTurnStart(sessionId, 1);

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Characterize context orchestration",
      constraints: ["Keep deterministic markers"],
    });
    runtime.task.recordBlocker(sessionId, {
      message: "failing test blocks progress",
      source: "test",
    });
    runtime.truth.upsertFact(sessionId, {
      id: "truth:ctx-char",
      kind: "diagnostic",
      severity: "warn",
      summary: "test truth fact",
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "Error: test failure marker",
      channelSuccess: false,
    });

    const injection = await runtime.context.buildInjection(
      sessionId,
      "continue context characterization",
      { tokens: 800, contextWindow: 4000, percent: 20 },
      "leaf-a",
    );
    expect(injection.accepted).toBe(true);
    expect(injection.text).toContain("[PersonaProfile]");
    expect(injection.text).not.toContain("[TruthLedger]");
    expect(injection.text).not.toContain("[TruthFacts]");
    expect(injection.text).toContain("[RuntimeStatus]");
    expect(injection.text).toContain("[TaskLedger]");
    expect(injection.text).toContain("[WorkingProjection]");
    expect(injection.text).toContain("\n\n");

    const injectedEvent = runtime.events.query(sessionId, { type: "context_injected", last: 1 })[0];
    expect(injectedEvent).toBeDefined();
    const payload = injectedEvent?.payload as
      | {
          sourceCount?: number;
          finalTokens?: number;
          originalTokens?: number;
          degradationApplied?: boolean;
          usagePercent?: number | null;
        }
      | undefined;
    expect(payload?.sourceCount).toBeGreaterThanOrEqual(4);
    expect(payload?.finalTokens).toBeGreaterThan(0);
    expect(payload?.originalTokens).toBeGreaterThanOrEqual(payload?.finalTokens ?? 0);
    expect(payload?.degradationApplied).toBe(false);
    expect(payload?.usagePercent).toBe(0.2);
  });

  test("drops duplicate fingerprint in same scope and emits context_injection_dropped", async () => {
    const workspace = createTestWorkspace("ctx-orchestrator-duplicate");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.projection.enabled = false;
    config.infrastructure.toolFailureInjection.enabled = false;
    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const sessionId = "ctx-orchestrator-duplicate-1";

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Keep scope fingerprint stable",
    });

    runtime.context.onTurnStart(sessionId, 1);
    const first = await runtime.context.buildInjection(
      sessionId,
      "duplicate fingerprint probe",
      { tokens: 600, contextWindow: 4000, percent: 0.15 },
      "leaf-a",
    );
    expect(first.accepted).toBe(true);
    expect(first.text.length).toBeGreaterThan(0);

    runtime.context.onTurnStart(sessionId, 2);
    const second = await runtime.context.buildInjection(
      sessionId,
      "duplicate fingerprint probe",
      { tokens: 600, contextWindow: 4000, percent: 0.15 },
      "leaf-a",
    );
    expect(second.accepted).toBe(false);
    expect(second.text).toBe("");

    const dropped = runtime.events.query(sessionId, {
      type: "context_injection_dropped",
      last: 1,
    })[0];
    expect(dropped).toBeDefined();
    const payload = dropped?.payload as { reason?: string; originalTokens?: number } | undefined;
    expect(payload?.reason).toBe("duplicate_content");
    expect(payload?.originalTokens).toBeGreaterThan(0);
  });
});
