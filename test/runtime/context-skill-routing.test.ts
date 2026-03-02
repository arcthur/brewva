import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

describe("context skill routing", () => {
  test("injects skill candidates and emits routing decision event", async () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.memory.enabled = false;
    config.infrastructure.toolFailureInjection.enabled = false;

    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("ctx-skill-routing"),
      config,
    });
    const sessionId = "ctx-skill-routing-1";
    runtime.context.onTurnStart(sessionId, 1);

    const injection = await runtime.context.buildInjection(
      sessionId,
      "Review architecture risks in this project",
      { tokens: 640, contextWindow: 4096, percent: 0.16 },
      "leaf-a",
    );

    expect(injection.accepted).toBe(true);
    expect(injection.text.includes("Top-K Skill Candidates:")).toBe(true);
    expect(injection.text.includes("- review")).toBe(true);

    const routed = runtime.events.query(sessionId, { type: "skill_routing_decided", last: 1 })[0];
    expect(routed).toBeDefined();
    const payload = routed?.payload as { selectedCount?: number } | undefined;
    expect((payload?.selectedCount ?? 0) > 0).toBe(true);
  });

  test("skips low-confidence suggested candidates in context injection", async () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.memory.enabled = false;
    config.infrastructure.toolFailureInjection.enabled = false;

    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("ctx-skill-routing-low-confidence"),
      config,
    });
    const sessionId = "ctx-skill-routing-2";
    runtime.context.onTurnStart(sessionId, 1);

    const injection = await runtime.context.buildInjection(
      sessionId,
      "Can you plan?",
      { tokens: 640, contextWindow: 4096, percent: 0.16 },
      "leaf-b",
    );

    expect(injection.accepted).toBe(true);
    expect(injection.text.includes("Top-K Skill Candidates:")).toBe(false);

    const routed = runtime.events.query(sessionId, { type: "skill_routing_decided", last: 1 })[0];
    expect(routed).toBeDefined();
    const payload = routed?.payload as
      | { mode?: string; confidence?: number; selectedCount?: number }
      | undefined;
    expect(payload?.mode).toBe("suggest");
    expect(payload?.selectedCount).toBeGreaterThan(0);
    expect((payload?.confidence ?? 1) < 0.55).toBe(true);
  });
});
