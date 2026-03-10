import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG, type BrewvaConfig } from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-skill-dispatch-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

function createConfig(mode: BrewvaConfig["security"]["mode"]): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.security.mode = mode;
  config.projection.enabled = false;
  config.infrastructure.toolFailureInjection.enabled = false;
  config.skills.cascade.mode = "off";
  config.skills.overrides.review = {
    dispatch: {
      gateThreshold: 1,
      autoThreshold: 100,
      defaultMode: "gate",
    },
  };
  return config;
}

function buildEvidenceRef(sessionId: string) {
  return {
    id: `${sessionId}:broker-trace`,
    sourceType: "broker_trace" as const,
    locator: "broker://test",
    createdAt: Date.now(),
  };
}

function prepareReviewDispatch(runtime: BrewvaRuntime, sessionId: string) {
  runtime.context.onTurnStart(sessionId, 1);
  return runtime.proposals.submit(sessionId, {
    id: `${sessionId}:selection`,
    kind: "skill_selection",
    issuer: "test.broker",
    subject: "review request",
    payload: {
      selected: [
        {
          name: "review",
          score: 10,
          reason: "semantic:review request",
          breakdown: [{ signal: "semantic_match", term: "review", delta: 10 }],
        },
      ],
      routingOutcome: "selected",
    },
    evidenceRefs: [buildEvidenceRef(sessionId)],
    createdAt: Date.now(),
  });
}

describe("skill dispatch gate", () => {
  test("strict mode blocks non-lifecycle tools while gate is pending", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("strict-block"),
      config: createConfig("strict"),
    });
    const sessionId = "skill-dispatch-strict-1";
    const receipt = prepareReviewDispatch(runtime, sessionId);

    expect(receipt.decision).toBe("accept");
    expect(runtime.skills.getPendingDispatch(sessionId)?.mode).toBe("gate");
    expect(runtime.skills.getPendingDispatch(sessionId)?.primary?.name).toBe("review");

    const blocked = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-blocked",
      toolName: "exec",
      args: { command: "echo blocked" },
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason?.includes("skill_load")).toBe(true);

    const loadAllowed = runtime.tools.start({
      sessionId,
      toolCallId: "tc-load",
      toolName: "skill_load",
      args: { name: "review" },
    });
    expect(loadAllowed.allowed).toBe(true);

    expect(runtime.skills.activate(sessionId, "review").ok).toBe(true);
    expect(runtime.skills.getPendingDispatch(sessionId)).toBeUndefined();

    expect(
      runtime.events.query(sessionId, { type: "skill_routing_followed", last: 1 }),
    ).toHaveLength(1);
  });

  test("empty proposals do not fabricate a conservative kernel gate", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("empty-selection"),
      config: createConfig("strict"),
    });
    const sessionId = "skill-dispatch-empty-1";

    const receipt = runtime.proposals.submit(sessionId, {
      id: `${sessionId}:selection`,
      kind: "skill_selection",
      issuer: "test.broker",
      subject: "review architecture risks",
      payload: {
        selected: [],
        routingOutcome: "failed",
      },
      evidenceRefs: [buildEvidenceRef(sessionId)],
      createdAt: Date.now(),
    });
    expect(receipt.decision).toBe("defer");
    expect(runtime.skills.getPendingDispatch(sessionId)).toBeUndefined();
  });

  test("standard mode warns but does not block", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("standard-warn"),
      config: createConfig("standard"),
    });
    const sessionId = "skill-dispatch-standard-1";
    prepareReviewDispatch(runtime, sessionId);

    const allowed = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-warn",
      toolName: "exec",
      args: { command: "echo warn" },
    });
    expect(allowed.allowed).toBe(true);
    expect(
      runtime.events.query(sessionId, { type: "skill_dispatch_gate_warning", last: 1 }),
    ).toHaveLength(1);
  });

  test("permissive mode neither blocks nor warns", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("permissive-off"),
      config: createConfig("permissive"),
    });
    const sessionId = "skill-dispatch-permissive-1";
    prepareReviewDispatch(runtime, sessionId);

    const allowed = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-permissive",
      toolName: "exec",
      args: { command: "echo permissive" },
    });
    expect(allowed.allowed).toBe(true);
    expect(runtime.events.query(sessionId, { type: "skill_dispatch_gate_warning" })).toHaveLength(
      0,
    );
  });

  test("manual override clears pending dispatch and emits overridden event", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("override"),
      config: createConfig("strict"),
    });
    const sessionId = "skill-dispatch-override-1";
    prepareReviewDispatch(runtime, sessionId);

    const override = runtime.skills.overridePendingDispatch(sessionId, {
      reason: "human_operator_override",
      targetSkillName: "design",
    });
    expect(override.ok).toBe(true);
    expect(runtime.skills.getPendingDispatch(sessionId)).toBeUndefined();
    expect(
      runtime.events.query(sessionId, { type: "skill_routing_overridden", last: 1 }),
    ).toHaveLength(1);
  });

  test("turn-end reconciliation emits ignored once and clears gate", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("ignored"),
      config: createConfig("strict"),
    });
    const sessionId = "skill-dispatch-ignored-1";
    prepareReviewDispatch(runtime, sessionId);

    runtime.skills.reconcilePendingDispatch(sessionId, 1);
    expect(runtime.skills.getPendingDispatch(sessionId)).toBeUndefined();
    expect(
      runtime.events.query(sessionId, { type: "skill_routing_ignored", last: 1 }),
    ).toHaveLength(1);
  });
});
