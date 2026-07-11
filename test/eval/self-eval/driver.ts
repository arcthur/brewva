import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { resolveWorkspaceRootDir } from "@brewva/brewva-runtime/config";
import {
  findFinalBundle,
  latestCanonicalTapeFile,
  parseEventFile,
  parseJsonLines,
} from "../../helpers/events.js";
import { spawnPrintTurn } from "../print-turn.js";
import { stageWorkspaceFiles } from "../workspace-staging.js";
import { extractSelfEvalRunMetrics } from "./metrics.js";
import { runFixtureOracle } from "./oracle.js";
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
 * Assemble a run outcome from evidence split by provenance: structural metrics
 * from the run's DURABLE tape (the commitment record), the cost observation from
 * the run's own reported cost summary on stdout, and TASK SUCCESS from the
 * fixture's post-run oracle over the final workspace. Task success is decided
 * ONLY on a cleanly completed turn: a timed-out / suspended / incomplete /
 * unknown run is `terminal_incomplete` and the oracle is not run — an unfinished
 * run's task success is undefined, never a silent pass. A run that produced no
 * tape is recorded honestly (`tapePresent: false`) rather than scored as success.
 *
 * Separated from the live spawn so the read/collect/score path is unit-testable
 * over a staged workspace without a provider — the spawn needs a model, this
 * does not (the oracle runs the fixture's own test, no provider).
 */
export async function collectRunOutcome(input: {
  readonly fixture: Pick<SelfEvalFixture, "id" | "kind" | "oracle" | "workspaceFiles">;
  readonly workspace: string;
  readonly stdout: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}): Promise<SelfEvalRunResult> {
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
  const metrics = cost ? { ...structural, cost } : structural;
  const taskOutcome =
    input.timedOut || structural.terminalOutcome !== "completed"
      ? ("terminal_incomplete" as const)
      : await runFixtureOracle({
          oracle: input.fixture.oracle,
          workspace: input.workspace,
          stagedFiles: input.fixture.workspaceFiles,
        });
  return {
    fixtureId: input.fixture.id,
    kind: input.fixture.kind,
    metrics,
    taskOutcome,
    exitCode: input.exitCode,
    timedOut: input.timedOut,
    tapePresent: tapeFile !== undefined,
    workspace: input.workspace,
  };
}

export function requireOperatorApprovalPolicy(fixture: SelfEvalFixture): void {
  if (Object.keys(fixture.operatorApprovalPolicy).length === 0) {
    throw new Error(
      `Self-eval fixture ${fixture.id} must declare a non-empty operatorApprovalPolicy — ` +
        `that operator-delivered envelope is the only channel that lets an exec-needing task ` +
        `finish unattended (the Phase-1 chain).`,
    );
  }
}

/**
 * Stage the operator approval config OUTSIDE the model-writable workspace and
 * return its path. Written to a sibling temp dir under the workspace's PARENT,
 * so the run's `cwd` (the workspace) never contains it — the loader's
 * operator-source barrier honors an out-of-workspace policy and strips a
 * workspace-internal one. A model with workspace-write cannot reach here to
 * widen its own envelope. (`local_exec` remains host execution — a separate
 * trust boundary; do not grant it to untrusted models on an unsandboxed host.)
 */
function stageOperatorApprovalConfig(fixture: SelfEvalFixture, parentDir: string): string {
  const operatorDir = mkdtempSync(join(parentDir, `brewva-self-eval-operator-${fixture.id}-`));
  const configPath = join(operatorDir, "brewva.json");
  writeFileSync(
    configPath,
    `${JSON.stringify({ security: { unattendedApproval: fixture.operatorApprovalPolicy } }, null, 2)}\n`,
    "utf8",
  );
  return configPath;
}

/**
 * Fail LOUD, not silent, if the operator config would land inside the workspace's
 * resolved repo root: the loader's operator-source barrier would strip its policy
 * and every exec fixture would silently suspend to `terminal_incomplete` with no
 * explanation. The default tmpdir parent is safe (no repo ancestor), but a
 * `workspaceParentDir` inside a git/.brewva tree would share that root — this
 * guard turns that footgun into an actionable error.
 */
export function assertOperatorConfigOutsideWorkspace(
  operatorConfigPath: string,
  workspace: string,
): void {
  const workspaceRoot = resolveWorkspaceRootDir(workspace);
  const rel = relative(workspaceRoot, operatorConfigPath);
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  if (inside) {
    throw new Error(
      `Self-eval operator config ${operatorConfigPath} resolved INSIDE the workspace root ` +
        `${workspaceRoot} — the operator-source barrier would strip its unattendedApproval and ` +
        `every exec fixture would silently suspend. Use a workspaceParentDir outside any ` +
        `git/.brewva repo (the default tmpdir is safe).`,
    );
  }
}

/**
 * Drive one hermetic `brewva --json --backend embedded` run for a fixture and
 * collect its outcome. Live: it spawns a real turn and needs a provider in the
 * environment. The operator approval policy is delivered from OUTSIDE the
 * workspace (the operator-source barrier) so exec-needing tasks finish (the
 * Phase-1 chain); the workspace is kept for inspection.
 */
export async function driveSelfEvalRun(input: {
  readonly fixture: SelfEvalFixture;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly workspaceParentDir?: string;
}): Promise<SelfEvalRunResult> {
  requireOperatorApprovalPolicy(input.fixture);
  const parentDir = input.workspaceParentDir ?? tmpdir();
  const workspace = mkdtempSync(join(parentDir, `brewva-self-eval-${input.fixture.id}-`));
  stageWorkspaceFiles(
    input.fixture.workspaceFiles,
    workspace,
    `Self-eval fixture ${input.fixture.id}`,
  );
  const operatorConfigPath = stageOperatorApprovalConfig(input.fixture, parentDir);
  assertOperatorConfigOutsideWorkspace(operatorConfigPath, workspace);
  const { stdout, exitCode, timedOut } = await spawnPrintTurn({
    prompt: input.fixture.prompt,
    model: input.model,
    cwd: workspace,
    // JSON mode so the per-run cost summary lands on stdout as a
    // brewva_event_bundle; `--print` (text) writes cost to stderr only.
    mode: "json",
    backend: "embedded",
    // The operator config is an ABSOLUTE path outside the workspace, so the
    // loader honors its unattendedApproval (a workspace-internal one is stripped).
    extraArgs: ["--config", operatorConfigPath],
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  return collectRunOutcome({ fixture: input.fixture, workspace, stdout, exitCode, timedOut });
}
