import { describe, expect, test } from "bun:test";
import { SELF_EVAL_FIXTURES } from "../../eval/self-eval/fixtures.js";

const VALID_KINDS = new Set(["build", "debug", "comprehension"]);
// The effect classes an unattendedApproval policy may key on (ToolEffectClass).
const VALID_EFFECT_CLASSES = new Set([
  "workspace_read",
  "workspace_write",
  "local_exec",
  "runtime_observe",
  "external_network",
  "external_side_effect",
  "schedule_mutation",
  "memory_write",
  "budget_mutation",
  "control_state_mutation",
  "delegation",
  "credential_access",
]);
const VALID_DECISIONS = new Set(["allow", "deny"]);

describe("self-eval fixtures (frozen evaluator definitions)", () => {
  test("every fixture has a unique id, valid kind, and non-empty prompt", () => {
    const ids = new Set<string>();
    for (const fixture of SELF_EVAL_FIXTURES) {
      expect(fixture.id.length).toBeGreaterThan(0);
      expect(ids.has(fixture.id)).toBe(false);
      ids.add(fixture.id);
      expect(VALID_KINDS.has(fixture.kind)).toBe(true);
      expect(fixture.prompt.trim().length).toBeGreaterThan(0);
      expect(fixture.description.trim().length).toBeGreaterThan(0);
    }
    expect(SELF_EVAL_FIXTURES.length).toBeGreaterThanOrEqual(3);
  });

  test("covers build, debug, and comprehension kinds (the n=12 seed)", () => {
    const kinds = new Set(SELF_EVAL_FIXTURES.map((fixture) => fixture.kind));
    expect(kinds.has("build")).toBe(true);
    expect(kinds.has("debug")).toBe(true);
    expect(kinds.has("comprehension")).toBe(true);
  });

  test("every fixture declares a valid operatorApprovalPolicy (the Phase-1 chain)", () => {
    for (const fixture of SELF_EVAL_FIXTURES) {
      const policy = fixture.operatorApprovalPolicy;
      expect(typeof policy).toBe("object");
      const entries = Object.entries(policy);
      expect(entries.length).toBeGreaterThan(0);
      for (const [effectClass, decision] of entries) {
        expect(VALID_EFFECT_CLASSES.has(effectClass)).toBe(true);
        expect(VALID_DECISIONS.has(decision)).toBe(true);
      }
      // The class that the only approval-gated primitive (exec) projects must be
      // allowed, or exec-needing tasks would never finish unattended.
      expect(policy.local_exec).toBe("allow");
    }
  });

  test("the approval policy is NOT staged into the model-writable workspace", () => {
    // The operator-source barrier: a policy inside the workspace would be stripped
    // as model-writable, so fixtures must not smuggle one in via workspaceFiles.
    for (const fixture of SELF_EVAL_FIXTURES) {
      for (const path of Object.keys(fixture.workspaceFiles)) {
        expect(path.includes("brewva.json")).toBe(false);
      }
    }
  });

  test("every fixture declares a post-run oracle", () => {
    for (const fixture of SELF_EVAL_FIXTURES) {
      const oracle = fixture.oracle;
      if (oracle.kind === "command") {
        expect(oracle.command.length).toBeGreaterThan(0);
      } else {
        expect(oracle.kind).toBe("readonly_unchanged");
        expect(oracle.paths.length).toBeGreaterThan(0);
      }
    }
  });

  test("no workspace file path escapes the workspace", () => {
    for (const fixture of SELF_EVAL_FIXTURES) {
      for (const path of Object.keys(fixture.workspaceFiles)) {
        expect(path.startsWith("/")).toBe(false);
        expect(path.includes("..")).toBe(false);
      }
    }
  });
});
