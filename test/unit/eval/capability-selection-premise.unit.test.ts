import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  assertCapabilitySelectionPremise,
  type CapabilitySelectionPremiseCheck,
} from "../../eval/capability-premise.js";
import {
  buildGenericScenarioPrompt,
  stageScenarioWorkspaceFiles,
} from "../../eval/generic-runtime.js";
import type { EvalScenario } from "../../eval/types.js";

// The premise gate exists because this failure mode is invisible from grades
// alone: when intent scoring selects the staged capability, the model
// truthfully answers `already_selected: true` and the rubric (built on the
// never-selected premise) scores the truthful answer as 0%. These tests pin
// (a) the shipped scenario's premise against the REAL selector and (b) that
// the gate actually bites when the premise is broken.

const SCENARIO_PATH = join(
  import.meta.dir,
  "../../eval/scenarios/harness-fluency-capability-request.yaml",
);

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function assertPremiseOnStagedWorkspace(
  scenario: EvalScenario,
): CapabilitySelectionPremiseCheck | undefined {
  const workspaceDir = mkdtempSync(join(tmpdir(), "brewva-premise-"));
  tempDirs.push(workspaceDir);
  stageScenarioWorkspaceFiles(scenario, workspaceDir);
  return assertCapabilitySelectionPremise({
    scenario,
    workspaceDir,
    prompt: buildGenericScenarioPrompt(scenario),
  });
}

function captureError(run: () => void): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`expected an Error, got: ${String(error)}`, { cause: error });
  }
  throw new Error("expected the premise assertion to throw, but it passed");
}

function syntheticManifestYaml(whenToUse: string): string {
  return [
    "name: slack-notify",
    "provider: slack",
    "domain: messaging",
    "action: notify",
    "tool_names:",
    "  - agent_send",
    "resource_types:",
    "  - message",
    "risk_level: write",
    "agent_scope:",
    "  - coding-agent",
    "workspace_scope:",
    "  - default",
    "auth_profile: ops-slack",
    "selection:",
    `  when_to_use: ${whenToUse}`,
    "",
  ].join("\n");
}

function syntheticScenario(input: {
  whenToUse: string;
  policyAgentScope?: string[];
  includeConfig?: boolean;
}): EvalScenario {
  const config = {
    capabilities: {
      roots: ["capabilities"],
      policy: {
        agentScope: input.policyAgentScope ?? ["coding-agent"],
        workspaceScope: ["default"],
        allowedAccounts: ["ops-slack"],
      },
    },
  };
  return {
    id: "premise-synthetic",
    skill: "harness-fluency",
    description: "synthetic premise probe",
    premise: {
      capability_selection: {
        selected_capability_names: [],
        selectable_capability_names: ["slack-notify"],
      },
    },
    context: {
      task_description:
        "The deploy for release 7.3 just finished. Use the workspace integration to tell the on-call crew.",
      workspace_files: {
        ...(input.includeConfig === false
          ? {}
          : { ".brewva/brewva.json": JSON.stringify(config, null, 2) }),
        "capabilities/slack-notify.yaml": syntheticManifestYaml(input.whenToUse),
      },
    },
    rubric_path: "unused",
    output_contracts: {
      turn_plan: { kind: "text", min_words: 3 },
    },
  };
}

describe("capability-selection premise gate", () => {
  test("the shipped capability-request scenario declares the premise and it holds against the real selector", () => {
    const scenario = parse(readFileSync(SCENARIO_PATH, "utf8")) as EvalScenario;
    expect(scenario.premise?.capability_selection?.selected_capability_names).toEqual([]);
    expect(scenario.premise?.capability_selection?.selectable_capability_names).toEqual([
      "slack-notify",
    ]);
    expect(assertPremiseOnStagedWorkspace(scenario)).toEqual({ selectedCapabilityNames: [] });
  });

  test("prose stopwords in when_to_use break the premise, and the error names score and token overlap", () => {
    const scenario = syntheticScenario({
      whenToUse: "Use for posting operational updates to the team Slack channel.",
    });
    const error = captureError(() => assertPremiseOnStagedWorkspace(scenario));
    expect(error.message).toContain("premise violated");
    expect(error.message).toContain("selected [slack-notify]");
    expect(error.message).toContain("score");
    expect(error.message).toContain("prompt∩manifest tokens:");
  });

  test("a token-disjoint manifest surface satisfies the premise", () => {
    const scenario = syntheticScenario({
      whenToUse: "Posting operational status updates into #ops-oncall Slack channel.",
    });
    expect(assertPremiseOnStagedWorkspace(scenario)).toEqual({ selectedCapabilityNames: [] });
  });

  test("a policy-filtered manifest fails the selectable assertion loudly", () => {
    const scenario = syntheticScenario({
      whenToUse: "Posting operational status updates into #ops-oncall Slack channel.",
      policyAgentScope: ["review-agent"],
    });
    const error = captureError(() => assertPremiseOnStagedWorkspace(scenario));
    expect(error.message).toContain("policy-forbidden (agent_scope)");
  });

  test("a premise without a scenario-carried config is refused", () => {
    const scenario = syntheticScenario({
      whenToUse: "Posting operational status updates into #ops-oncall Slack channel.",
      includeConfig: false,
    });
    const error = captureError(() => assertPremiseOnStagedWorkspace(scenario));
    expect(error.message).toContain("scenario-carried .brewva/brewva.json");
  });
});
