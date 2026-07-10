import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { assertCapabilitySelectionPremise } from "./capability-premise.js";
import type { EvalScenario, EvalTelemetry, OutputContract } from "./types.js";

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

const REPO_ROOT = resolve(import.meta.dir, "../..");
const CLI_ENTRY = resolve(REPO_ROOT, "packages/brewva-cli/src/index.ts");
const DEFAULT_TIMEOUT_MS = 180_000;

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

async function runPrintTurn(input: {
  readonly prompt: string;
  readonly model: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly cli?: GenericRuntimeCliOverrides;
}): Promise<string> {
  const args = [
    CLI_ENTRY,
    "--print",
    "--backend",
    input.cli?.backend ?? "embedded",
    ...(input.model && input.model !== "default" ? ["--model", input.model] : []),
    ...(input.cli?.extraArgs ?? []),
    // "--" terminates option parsing: a task_description starting with "-"
    // (markdown list prose) must never be read as a CLI flag.
    "--",
    input.prompt,
  ];
  const child = Bun.spawn(["bun", ...args], {
    cwd: input.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...input.cli?.env },
  });
  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    child.kill();
    // A descendant holding the stdout pipe can keep the streams open past
    // SIGTERM; escalate so the deadline is a real deadline.
    setTimeout(() => child.kill("SIGKILL"), 5_000);
  }, input.timeoutMs);
  const deadline = new Promise<never>((_, reject) => {
    setTimeout(
      () =>
        reject(
          new Error(
            `brewva --print timed out after ${input.timeoutMs}ms (workspace: ${input.cwd})`,
          ),
        ),
      input.timeoutMs + 10_000,
    );
  });
  try {
    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]),
      deadline,
    ]);
    if (timedOut) {
      throw new Error(
        `brewva --print timed out after ${input.timeoutMs}ms (workspace: ${input.cwd}): ${stderr
          .trim()
          .slice(-400)}`,
      );
    }
    if (exitCode !== 0) {
      throw new Error(
        `brewva --print exited ${exitCode} (workspace: ${input.cwd}): ${
          stderr.trim().slice(-800) || stdout.trim().slice(-800)
        }`,
      );
    }
    return stdout;
  } finally {
    clearTimeout(killTimer);
  }
}

/**
 * Materialize scenario workspace_files into the hermetic workspace. Exported
 * so premise tests stage EXACTLY what the runtime stages.
 */
export function stageScenarioWorkspaceFiles(scenario: EvalScenario, workspace: string): void {
  for (const [relativePath, content] of Object.entries(scenario.context.workspace_files ?? {})) {
    const absolutePath = resolve(workspace, relativePath);
    if (absolutePath !== workspace && !absolutePath.startsWith(`${workspace}/`)) {
      throw new Error(
        `Scenario ${scenario.id}: workspace_files path escapes the workspace: ${relativePath}`,
      );
    }
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, "utf8");
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
  const scenarioConfigArgs = Object.hasOwn(workspaceFiles, ".brewva/brewva.json")
    ? ["--config", ".brewva/brewva.json"]
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
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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
