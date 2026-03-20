import { describe, expect, test } from "bun:test";
import {
  getSkillOutputContracts,
  listSkillAllowedEffects,
  listSkillOutputs,
  mergeOverlayContract,
  resolveSkillEffectLevel,
  tightenContract,
  type SkillContractOverride,
} from "@brewva/brewva-runtime";
import { createContract } from "./skill-contract.helpers.js";

describe("skill contract tightening", () => {
  test("cannot relax denied effects or resource ceilings", () => {
    const base = createContract({
      name: "implementation",
      category: "core",
      routing: { scope: "core" },
      effects: {
        allowedEffects: ["workspace_read", "workspace_write"],
        deniedEffects: ["local_exec"],
      },
      resources: {
        defaultLease: { maxToolCalls: 50, maxTokens: 100000 },
        hardCeiling: { maxToolCalls: 50, maxTokens: 100000 },
      },
      executionHints: {
        preferredTools: ["read", "edit"],
        fallbackTools: ["grep"],
        costHint: "medium",
      },
    });

    const merged = tightenContract(base, {
      effects: {
        allowedEffects: ["workspace_read"],
        deniedEffects: ["external_network"],
      },
      resources: {
        defaultLease: { maxToolCalls: 10, maxTokens: 50000 },
      },
      executionHints: {
        preferredTools: ["read"],
        fallbackTools: ["grep", "write"],
      },
    });

    expect(merged.executionHints?.preferredTools).toEqual(["read"]);
    expect(merged.executionHints?.fallbackTools).toContain("grep");
    expect(merged.executionHints?.fallbackTools).not.toContain("write");
    expect(merged.effects?.allowedEffects).toEqual(["workspace_read"]);
    expect(merged.effects?.deniedEffects).toEqual(
      expect.arrayContaining(["local_exec", "external_network"]),
    );
    expect(merged.resources?.defaultLease).toEqual({ maxToolCalls: 10, maxTokens: 50000 });
    expect(merged.routing).toEqual({ scope: "core" });
  });

  test("project overlays add execution hints and denied effects without replacing output contracts", () => {
    const base = createContract({
      name: "debugging",
      category: "core",
      routing: { scope: "core" },
      intent: {
        outputs: ["root_cause"],
        outputContracts: {
          root_cause: {
            kind: "text",
            minWords: 3,
            minLength: 18,
          },
        },
      },
      effects: {
        allowedEffects: ["workspace_read", "local_exec"],
        deniedEffects: ["workspace_write"],
      },
      executionHints: {
        preferredTools: ["read", "exec"],
        fallbackTools: ["grep"],
        costHint: "medium",
      },
    });

    const merged = mergeOverlayContract(base, {
      effects: {
        allowedEffects: ["workspace_read", "local_exec", "workspace_write"],
        deniedEffects: ["external_network"],
      },
      executionHints: {
        preferredTools: ["tape_search"],
        fallbackTools: ["cost_view"],
      },
    });

    expect(merged.executionHints?.preferredTools).toEqual(
      expect.arrayContaining(["read", "exec", "tape_search"]),
    );
    expect(merged.executionHints?.fallbackTools).toEqual(
      expect.arrayContaining(["grep", "cost_view"]),
    );
    expect(merged.effects?.deniedEffects).toEqual(
      expect.arrayContaining(["workspace_write", "external_network"]),
    );
    expect(merged.effects?.allowedEffects).toEqual(["workspace_read", "local_exec"]);
    expect(listSkillOutputs(merged)).toEqual(["root_cause"]);
    expect(Object.keys(getSkillOutputContracts(merged))).toEqual(["root_cause"]);
  });

  test("preserves completion evidence kinds when overrides only tighten verification level", () => {
    const base = createContract({
      name: "review",
      category: "core",
      routing: { scope: "core" },
      intent: {
        outputs: ["review_report"],
        outputContracts: {
          review_report: {
            kind: "text",
            minWords: 3,
            minLength: 18,
          },
        },
        completionDefinition: {
          verificationLevel: "standard",
          requiredEvidenceKinds: ["ledger", "verification"],
        },
      },
    });

    const tightened = tightenContract(base, {
      intent: {
        completionDefinition: {
          verificationLevel: "quick",
        },
      },
    });
    const overlaid = mergeOverlayContract(base, {
      intent: {
        completionDefinition: {
          verificationLevel: "strict",
        },
      },
    });

    expect(tightened.intent?.completionDefinition).toEqual({
      verificationLevel: "quick",
      requiredEvidenceKinds: ["ledger", "verification"],
    });
    expect(overlaid.intent?.completionDefinition).toEqual({
      verificationLevel: "strict",
      requiredEvidenceKinds: ["ledger", "verification"],
    });
  });

  test("explicit empty allowed effects remain fully sandboxed instead of falling back to read-only", () => {
    const contract = createContract({
      name: "narrator",
      category: "core",
      effects: {
        allowedEffects: [],
        deniedEffects: [],
      },
    });

    expect(listSkillAllowedEffects(contract)).toEqual([]);
    expect(resolveSkillEffectLevel(contract)).toBe("read_only");
  });

  test("shared merge policies keep routing, effect tightening, and maxParallel aligned", () => {
    const base = createContract({
      name: "implementation",
      category: "core",
      routing: { scope: "core" },
      effects: {
        allowedEffects: ["workspace_read"],
      },
      resources: {
        defaultLease: { maxToolCalls: 50, maxTokens: 100000, maxParallel: 5 },
        hardCeiling: { maxToolCalls: 50, maxTokens: 100000, maxParallel: 5 },
      },
    });

    const override: SkillContractOverride = {
      resources: {
        defaultLease: { maxToolCalls: 12, maxTokens: 20000, maxParallel: 3 },
      },
      effects: {
        allowedEffects: ["workspace_read", "local_exec"],
      },
    };

    const tightened = tightenContract(base, override);
    const merged = mergeOverlayContract(
      {
        ...base,
        intent: {
          outputs: [],
          outputContracts: {},
        },
      },
      override,
    );

    for (const result of [tightened, merged]) {
      expect(result.resources?.defaultLease).toEqual({
        maxToolCalls: 12,
        maxTokens: 20000,
        maxParallel: 3,
      });
      expect(result.routing).toEqual({ scope: "core" });
      expect(result.resources?.defaultLease?.maxParallel).toBe(3);
      expect(resolveSkillEffectLevel(result)).toBe("read_only");
    }
  });
});
