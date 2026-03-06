import { describe, expect, test } from "bun:test";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";

function repoRoot(): string {
  return process.cwd();
}

describe("S-001 skill routing selector", () => {
  test("prepareDispatch routes deterministically by default", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "deterministic-route-1";

    const decision = runtime.skills.prepareDispatch(
      sessionId,
      "Review architecture risks, merge safety, and quality audit gaps",
    );

    expect(decision.primary?.name).toBe("review");
    expect(decision.mode).toBe("auto");
    expect(decision.selected.length).toBeGreaterThan(0);
    const trace = runtime.skills.getLastRouting(sessionId);
    expect(trace?.source).toBe("deterministic_router");
    expect(trace?.semantic.status).toBe("selected");
    expect(trace?.semantic.selectedSkills).toContain("review");
  });

  test("prepareDispatch stays empty in external_only mode without preselection", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.skills.selector.mode = "external_only";
    const runtime = new BrewvaRuntime({ cwd: repoRoot(), config });
    const sessionId = "external-only-1";

    const decision = runtime.skills.prepareDispatch(sessionId, "review architecture risks");
    expect(decision.mode).toBe("none");
    expect(decision.selected).toEqual([]);
    const trace = runtime.skills.getLastRouting(sessionId);
    expect(trace?.source).toBe("external_preselection");
    expect(trace?.semantic.status).toBe("empty");
    expect(trace?.semantic.reason).toBe("external_only_no_preselection");
  });

  test("prepareDispatch consumes injected preselection before deterministic routing", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "semantic-preselect-1";

    runtime.skills.setNextSelection(sessionId, [
      {
        name: "review",
        score: 20,
        reason: "semantic:review request",
        breakdown: [{ signal: "semantic_match", term: "semantic", delta: 20 }],
      },
    ]);

    const decision = runtime.skills.prepareDispatch(
      sessionId,
      "this text should not override explicit routing",
    );

    expect(decision.primary?.name).toBe("review");
    expect(decision.selected.length).toBe(1);
    expect(decision.mode).toBe("auto");
    const trace = runtime.skills.getLastRouting(sessionId);
    expect(trace?.source).toBe("external_preselection");
    expect(trace?.semantic.reason).toBe("external_preselection_selected");
  });

  test("prepareDispatch enters conservative gate when routing failed", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "semantic-preselect-failed";

    runtime.skills.setNextSelection(sessionId, [], {
      routingOutcome: "failed",
    });

    const decision = runtime.skills.prepareDispatch(sessionId, "review architecture risks");
    expect(decision.mode).toBe("gate");
    expect(decision.primary).toBeNull();
    expect(decision.routingOutcome).toBe("failed");
    expect(decision.reason).toBe("routing-failed");
  });
});
