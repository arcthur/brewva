import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { HostedSubagentProfile } from "../../../packages/brewva-gateway/src/subagents/profiles.js";
import {
  assertDelegationShapeNarrowing,
  resolveDelegationExecutionPlan,
  resolveDelegationProfile,
} from "../../../packages/brewva-gateway/src/subagents/shared.js";

function makeProfile(overrides: Partial<HostedSubagentProfile> = {}): HostedSubagentProfile {
  return {
    name: "review",
    description: "Read-only reviewer",
    resultMode: "review",
    prompt: "Review and summarize.",
    boundary: "safe",
    builtinToolNames: ["read"],
    managedToolNames: ["grep"],
    managedToolMode: "direct",
    ...overrides,
  };
}

describe("subagent shared execution resolution", () => {
  test("assertDelegationShapeNarrowing rejects widening overrides", () => {
    const profile = makeProfile();

    expect(() =>
      assertDelegationShapeNarrowing(profile, {
        boundary: "effectful",
      }),
    ).toThrow("subagent_effect_ceiling_widening_not_allowed");
    expect(() =>
      assertDelegationShapeNarrowing(profile, {
        resultMode: "patch",
      }),
    ).toThrow("subagent_result_mode_override_not_allowed");
    expect(() =>
      assertDelegationShapeNarrowing(profile, {
        managedToolMode: "extension",
      }),
    ).toThrow("subagent_managed_tool_mode_widening_not_allowed");
  });

  test("resolveDelegationExecutionPlan shares execution hint assembly between caller paths", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-subagent-shared-plan-")),
    });
    const profile = makeProfile({
      boundary: "effectful",
      builtinToolNames: ["read"],
      managedToolNames: [],
    });

    const plan = resolveDelegationExecutionPlan({
      runtime,
      profile,
      packet: {
        objective: "Review the gateway deltas.",
        executionHints: {
          preferredTools: ["edit", "grep"],
          fallbackTools: ["write", "subagent_run"],
        },
        effectCeiling: {
          boundary: "safe",
        },
      },
      executionShape: {
        boundary: "safe",
        model: "openai/gpt-5.4-mini",
      },
    });

    expect(plan.boundary).toBe("safe");
    expect(plan.model).toBe("openai/gpt-5.4-mini");
    expect(plan.managedToolMode).toBe("direct");
    expect(plan.builtinToolNames).toEqual(["read"]);
    expect(plan.managedToolNames).toContain("grep");
    expect(plan.managedToolNames).not.toContain("subagent_run");
    expect(plan.prompt).toBe("Review and summarize.");
  });

  test("resolveDelegationProfile derives a default preset from executionShape.resultMode", () => {
    const profiles = new Map<string, HostedSubagentProfile>([
      ["review", makeProfile()],
      [
        "verification",
        {
          name: "verification",
          description: "Verification runner",
          resultMode: "verification",
          prompt: "Verify and summarize.",
          boundary: "safe",
          builtinToolNames: ["read"],
          managedToolNames: ["grep"],
          managedToolMode: "direct",
        },
      ],
    ]);

    const resolved = resolveDelegationProfile({
      profiles,
      request: {
        executionShape: {
          resultMode: "verification",
          boundary: "safe",
        },
      },
    });

    expect(resolved.profileName).toBe("verification");
    expect(resolved.profile.resultMode).toBe("verification");
  });
});
