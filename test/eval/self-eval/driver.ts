import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findFinalBundle,
  latestCanonicalTapeFile,
  parseEventFile,
  parseJsonLines,
} from "../../helpers/events.js";
import { SCENARIO_CARRIED_CONFIG_KEY } from "../capability-premise.js";
import { spawnPrintTurn } from "../print-turn.js";
import { stageWorkspaceFiles } from "../workspace-staging.js";
import { extractSelfEvalRunMetrics } from "./metrics.js";
import type { SelfEvalCostObservation, SelfEvalFixture, SelfEvalRunResult } from "./types.js";

function readCostObservation(stdout: string): SelfEvalCostObservation | undefined {
  const summary = findFinalBundle(parseJsonLines(stdout))?.costSummary;
  if (!summary) return undefined;
  const totalTokens = typeof summary.totalTokens === "number" ? summary.totalTokens : undefined;
  const totalCostUsd = typeof summary.totalCostUsd === "number" ? summary.totalCostUsd : undefined;
  if (totalTokens === undefined && totalCostUsd === undefined) return undefined;
  return {
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
  };
}

/**
 * Assemble a run outcome from evidence split by provenance: the structural
 * metrics come from the run's DURABLE tape (the commitment record), the cost
 * observation from the run's own reported cost summary on stdout. A run that
 * produced no tape is recorded honestly (`tapePresent: false`, `unknown`
 * outcome) rather than silently scoring an empty run as success.
 *
 * Separated from the live spawn so the read/collect path is unit-testable over a
 * staged workspace without a provider — the spawn needs a model, this does not.
 */
export function collectRunOutcome(input: {
  readonly fixture: Pick<SelfEvalFixture, "id" | "kind">;
  readonly workspace: string;
  readonly stdout: string;
  readonly exitCode: number | null;
}): SelfEvalRunResult {
  const tapeFile = latestCanonicalTapeFile(input.workspace);
  // Parse RAW, not the runtime.ops-operational remap: the embedded run commits
  // BOTH a canonical `turn.ended{cause,status}` and an advisory
  // `custom{namespace:"runtime.ops", kind:"turn.ended", payload:{}}` (and the
  // same for turn.started). The operational remap would rewrite the advisory
  // event's type to `turn.ended` — landing empty-payload AFTER the canonical one
  // in file order — and the terminal read would score a completed run as
  // incomplete. Production filters on the raw type too, so raw parse matches it.
  const events = tapeFile ? parseEventFile(tapeFile) : [];
  const structural = extractSelfEvalRunMetrics(events);
  const cost = readCostObservation(input.stdout);
  return {
    fixtureId: input.fixture.id,
    kind: input.fixture.kind,
    metrics: cost ? { ...structural, cost } : structural,
    exitCode: input.exitCode,
    tapePresent: tapeFile !== undefined,
    workspace: input.workspace,
  };
}

export function requireUnattendedApprovalCarrier(fixture: SelfEvalFixture): void {
  if (!Object.hasOwn(fixture.workspaceFiles, SCENARIO_CARRIED_CONFIG_KEY)) {
    throw new Error(
      `Self-eval fixture ${fixture.id} must carry "${SCENARIO_CARRIED_CONFIG_KEY}" with ` +
        `security.unattendedApproval — that carried config is the only channel that lets an ` +
        `exec-needing task finish unattended (the Phase-1 chain).`,
    );
  }
}

/**
 * Drive one hermetic `brewva --json --backend embedded` run for a fixture and
 * collect its outcome. Live: it spawns a real turn and needs a provider in the
 * environment. The fixture's carried `.brewva/brewva.json` supplies the
 * `security.unattendedApproval` policy that lets exec-needing tasks finish (the
 * Phase-1 chain); the workspace is kept for inspection.
 */
export async function driveSelfEvalRun(input: {
  readonly fixture: SelfEvalFixture;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly workspaceParentDir?: string;
}): Promise<SelfEvalRunResult> {
  requireUnattendedApprovalCarrier(input.fixture);
  const workspace = mkdtempSync(
    join(input.workspaceParentDir ?? tmpdir(), `brewva-self-eval-${input.fixture.id}-`),
  );
  stageWorkspaceFiles(
    input.fixture.workspaceFiles,
    workspace,
    `Self-eval fixture ${input.fixture.id}`,
  );
  const { stdout, exitCode } = await spawnPrintTurn({
    prompt: input.fixture.prompt,
    model: input.model,
    cwd: workspace,
    // JSON mode so the per-run cost summary lands on stdout as a
    // brewva_event_bundle; `--print` (text) writes cost to stderr only.
    mode: "json",
    backend: "embedded",
    extraArgs: ["--config", SCENARIO_CARRIED_CONFIG_KEY],
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  return collectRunOutcome({ fixture: input.fixture, workspace, stdout, exitCode });
}
