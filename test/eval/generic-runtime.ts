import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  assertCapabilitySelectionPremise,
  SCENARIO_CARRIED_CONFIG_KEY,
} from "./capability-premise.js";
import { DEFAULT_PRINT_TURN_TIMEOUT_MS, spawnPrintTurn } from "./print-turn.js";
import type { EvalScenario, EvalTelemetry, OutputContract } from "./types.js";
import { stageWorkspaceFiles } from "./workspace-staging.js";

// Generic-scenario runtime execution (the seam RuntimeExecutor refused to fake):
// each run is one REAL `brewva --print` turn in a hermetic temp workspace, so
// the measurement includes the actual hosted prompt assembly instead of a
// synthetic provider call. Outputs come back as named fenced blocks parsed
// without ever reading the scenario fixture (no expected-answer contamination).
//
// Prompt-variant A/B: a variant's statement text is materialized as the temp
// workspace's AGENTS.md, riding the EXISTING project-instructions channel
// (advisory authority). Caveats recorded here on purpose: (a) this measures
// the statements under advisory framing — a replicated delta justifies moving
// them into the operating contract, where compliance can only go up; (b) runs
// without a scenario-carried config still read the operator's global brewva
// config and agent-dir instruction files (that env also carries the provider
// credentials the turn needs), so ABSOLUTE pass rates are machine-dependent —
// only the within-machine baseline/candidate DELTA is the measurement.

export interface GenericRuntimeCliOverrides {
  /** Backend for the print turn; real eval runs default to "embedded". */
  readonly backend?: "embedded" | "gateway";
  /** Extra CLI args (test harnesses inject --cwd/--config here). */
  readonly extraArgs?: readonly string[];
  /** Extra environment (test harnesses inject fake-provider overrides). */
  readonly env?: Record<string, string | undefined>;
}

export interface GenericRuntimeExecutionInput {
  readonly scenario: EvalScenario;
  /** Eval-level model id; "default" defers to the workspace configuration. */
  readonly model: string;
  /** Prompt-variant text written to the workspace AGENTS.md; null = baseline. */
  readonly variantText: string | null;
  readonly variantName: string;
  readonly timeoutMs?: number;
  readonly cli?: GenericRuntimeCliOverrides;
}

export interface GenericRuntimeExecutionResult {
  readonly outputs: Record<string, unknown>;
  readonly telemetry: EvalTelemetry;
  readonly rawText: string;
}

function describeContract(name: string, contract: OutputContract): string {
  const kind = contract.kind === "json" ? "valid JSON" : contract.kind;
  return `- ${name} (${kind})`;
}

function renderArtifacts(artifacts: Record<string, unknown> | undefined): string {
  if (!artifacts || Object.keys(artifacts).length === 0) {
    return "";
  }
  const lines = Object.entries(artifacts).map(
    ([key, value]) => `- ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
  return `\nContext artifacts:\n${lines.join("\n")}\n`;
}

/**
 * The full prompt is assembled from scenario fields only — never from the
 * fixture or rubric, which stay grader-side.
 */
export function buildGenericScenarioPrompt(scenario: EvalScenario): string {
  const contracts = Object.entries(scenario.output_contracts)
    .map(([name, contract]) => describeContract(name, contract))
    .join("\n");
  const workspaceState = scenario.context.workspace_state
    ? `\nWorkspace state:\n${scenario.context.workspace_state.trim()}\n`
    : "";
  return [
    scenario.context.task_description.trim(),
    renderArtifacts(scenario.context.available_artifacts),
    workspaceState,
    "\nRespond with EXACTLY one fenced code block per required output, using the",
    "output name as the fence info string (for example ```turn_plan). Emit the",
    "blocks and nothing else after them. Never nest triple-backtick fences",
    "inside an output block.",
    "Required outputs:",
    contracts,
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

/**
 * Parse named fenced blocks. JSON contracts are parsed; a malformed block is
 * kept as the raw string so the shape grader fails it honestly instead of the
 * executor masking the miss.
 */
export function parseNamedOutputs(
  text: string,
  contracts: Record<string, OutputContract>,
): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (const [name, contract] of Object.entries(contracts)) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const fence = new RegExp("^```" + escapedName + "[^\\S\\n]*\\n([\\s\\S]*?)^```", "mu").exec(
      text,
    );
    const body = fence?.[1]?.trim();
    if (body === undefined || body.length === 0) {
      continue;
    }
    if (contract.kind === "json") {
      try {
        outputs[name] = JSON.parse(body);
      } catch {
        outputs[name] = body;
      }
      continue;
    }
    outputs[name] = body;
  }
  return outputs;
}

// Generic scenarios need the throw-on-failure contract (a non-zero exit means
// no parseable answer), so this wraps the shared non-throwing spawn and raises.
async function runPrintTurn(input: {
  readonly prompt: string;
  readonly model: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly cli?: GenericRuntimeCliOverrides;
}): Promise<string> {
  const result = await spawnPrintTurn({
    prompt: input.prompt,
    model: input.model,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    ...(input.cli?.backend ? { backend: input.cli.backend } : {}),
    ...(input.cli?.extraArgs ? { extraArgs: input.cli.extraArgs } : {}),
    ...(input.cli?.env ? { env: input.cli.env } : {}),
  });
  if (result.timedOut) {
    throw new Error(
      `brewva --print timed out after ${input.timeoutMs}ms (workspace: ${input.cwd}): ${result.stderr
        .trim()
        .slice(-400)}`,
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `brewva --print exited ${result.exitCode} (workspace: ${input.cwd}): ${
        result.stderr.trim().slice(-800) || result.stdout.trim().slice(-800)
      }`,
    );
  }
  return result.stdout;
}

/**
 * Materialize scenario workspace_files into the hermetic workspace. Exported
 * so premise tests stage EXACTLY what the runtime stages.
 */
export function stageScenarioWorkspaceFiles(scenario: EvalScenario, workspace: string): void {
  stageWorkspaceFiles(scenario.context.workspace_files ?? {}, workspace, `Scenario ${scenario.id}`);
}

/**
 * A capability-selection premise is only predictive when the spawned CLI
 * resolves the same workspace and config the gate validated. Reject --cwd or
 * --config overrides that point elsewhere instead of letting the guarantee
 * void silently (harness-injected extraArgs are the documented override
 * channel, so they must agree with the staged workspace).
 */
export function assertPremiseCompatibleCliOverrides(input: {
  scenario: EvalScenario;
  workspace: string;
  extraArgs: readonly string[];
}): void {
  if (!input.scenario.premise?.capability_selection) {
    return;
  }
  for (let index = 0; index < input.extraArgs.length - 1; index += 1) {
    const flag = input.extraArgs[index];
    if (flag !== "--cwd" && flag !== "--config") {
      continue;
    }
    const value = input.extraArgs[index + 1] ?? "";
    const resolved = resolve(input.workspace, value);
    const expected =
      flag === "--cwd" ? input.workspace : resolve(input.workspace, SCENARIO_CARRIED_CONFIG_KEY);
    if (resolved !== expected) {
      throw new Error(
        `Scenario ${input.scenario.id}: cli override "${flag} ${value}" diverges from the premise-validated workspace (expected ${expected}); the capability-selection premise cannot be guaranteed.`,
      );
    }
  }
}

export async function executeGenericRuntimeScenario(
  input: GenericRuntimeExecutionInput,
): Promise<GenericRuntimeExecutionResult> {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-eval-${input.scenario.id}-`));
  const workspaceFiles = input.scenario.context.workspace_files ?? {};
  stageScenarioWorkspaceFiles(input.scenario, workspace);
  if (input.variantText && input.variantText.trim().length > 0) {
    if (Object.hasOwn(workspaceFiles, "AGENTS.md")) {
      // Silently replacing a scenario-carried AGENTS.md would swap "statements
      // ADDED to the scenario instructions" for "statements INSTEAD of them",
      // corrupting the A/B semantics.
      throw new Error(
        `Scenario ${input.scenario.id}: carries its own AGENTS.md; a prompt variant cannot overwrite it`,
      );
    }
    writeFileSync(join(workspace, "AGENTS.md"), `${input.variantText.trim()}\n`, "utf8");
  }
  // A scenario-carried config keeps capability/policy state hermetic instead
  // of leaking the operator's global configuration into the measurement.
  const scenarioConfigArgs = Object.hasOwn(workspaceFiles, SCENARIO_CARRIED_CONFIG_KEY)
    ? ["--config", SCENARIO_CARRIED_CONFIG_KEY]
    : [];
  const cliOverrides: GenericRuntimeCliOverrides | undefined =
    scenarioConfigArgs.length > 0 || input.cli
      ? {
          ...input.cli,
          extraArgs: [...scenarioConfigArgs, ...(input.cli?.extraArgs ?? [])],
        }
      : undefined;
  const prompt = buildGenericScenarioPrompt(input.scenario);
  // Premise gate: checked against the real intent scorer BEFORE the turn is
  // spent. A violated premise throws (a visible scenario error) instead of
  // letting a truthful model answer about runtime state grade as 0%.
  assertPremiseCompatibleCliOverrides({
    scenario: input.scenario,
    workspace,
    extraArgs: input.cli?.extraArgs ?? [],
  });
  assertCapabilitySelectionPremise({
    scenario: input.scenario,
    workspaceDir: workspace,
    prompt,
  });
  const startedAt = performance.now();
  const rawText = await runPrintTurn({
    prompt,
    model: input.model,
    cwd: workspace,
    timeoutMs: input.timeoutMs ?? DEFAULT_PRINT_TURN_TIMEOUT_MS,
    ...(cliOverrides ? { cli: cliOverrides } : {}),
  });
  const durationMs = performance.now() - startedAt;
  return {
    outputs: parseNamedOutputs(rawText, input.scenario.output_contracts),
    rawText,
    telemetry: {
      kind: "generic",
      metrics: {
        variant: input.variantName,
        runtime_turn_duration_ms: Math.round(durationMs),
        raw_chars: rawText.length,
        // Workspaces are kept (not cleaned) so a graded run stays inspectable.
        workspace,
      },
    },
  };
}
