#!/usr/bin/env bun
// Offline calibration report over the advisory-heuristic receipt planes.
//
// Reads tape JSONL only (axiom 6: tape is commitment memory — no parallel
// telemetry store) and aggregates, per advisory surface, what its receipts
// already record:
//   - skill selection  (`skill.selection.recorded` + adoption = SKILL.md reads)
//   - task-stall watch (`task.stuck.detected` / `task.stall.adjudicated`)
//   - output distiller (`tool_output_distilled` + eligible-tool denominators)
//
// This is the shared "offline calibration recipe" required by the
// advisory-receipt-and-calibration-standard decision: a read-only view that
// grades whether each heuristic earns its keep. It derives a report, never a
// rule change (axiom 18) — promotion of any tuning stays a reviewed code change.
//
// Usage: bun run analyze:advisory-receipts [-- --tape <dir>]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  BREWVA_TOOL_SURFACE_BY_NAME,
  MANAGED_BREWVA_TOOL_NAMES,
} from "@brewva/brewva-tools/registry";

interface TapeEvent {
  kind: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Tape carries two envelope shapes: runtime-ops events land as type="custom"
// with the real kind under payload.kind (body under payload.payload), while
// canonical events (e.g. tool.committed) carry the kind as the type itself.
function decodeTapeLine(line: string): TapeEvent | null {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(record)) return null;
  const outerPayload = isRecord(record.payload) ? record.payload : undefined;
  const isOps = record.type === "custom";
  const kind = isOps ? readString(outerPayload?.kind) : readString(record.type);
  if (!kind) return null;
  const body = isOps ? outerPayload?.payload : record.payload;
  return {
    kind,
    timestamp: readNumber(record.timestamp) ?? 0,
    payload: isRecord(body) ? body : {},
  };
}

const READ_TOOL_NAMES = new Set(["source_read", "resource_read", "look_at", "read"]);

function normalizeReadTarget(target: string): string {
  let value = target.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (value.startsWith("brewva-resource:///file/")) {
    value = value.slice("brewva-resource:///file/".length);
  } else if (value.startsWith("file://")) {
    value = value.slice("file://".length);
  }
  return value;
}

function readTargetMatchesSkillFile(readTarget: string, skillFile: string): boolean {
  const target = normalizeReadTarget(readTarget.trim());
  const skill = normalizeReadTarget(skillFile.trim());
  if (!target || !skill) return false;
  return target === skill || target.endsWith(`/${skill}`) || skill.endsWith(`/${target}`);
}

function bump(counts: Map<string, number>, key: string, by = 1): void {
  counts.set(key, (counts.get(key) ?? 0) + by);
}

function formatCounts(counts: Map<string, number>): string[] {
  return [...counts.entries()]
    .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, count]) => `    ${String(count).padStart(5)}  ${key}`);
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "n/a";
}

function summarizeRatios(values: number[]): string {
  if (values.length === 0) return "n/a";
  const sorted = values.toSorted((left, right) => left - right);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return `mean=${mean.toFixed(3)} median=${median.toFixed(3)} min=${(sorted[0] ?? 0).toFixed(3)} max=${(sorted[sorted.length - 1] ?? 0).toFixed(3)}`;
}

function distillerStrategyGroup(toolName: string): string | null {
  if (toolName === "exec") return "exec";
  if (toolName === "grep") return "grep";
  if (toolName.startsWith("lsp_")) return "lsp_*";
  if (toolName === "browser_snapshot") return "browser_snapshot";
  if (toolName === "browser_diff_snapshot") return "browser_diff_snapshot";
  if (toolName === "browser_get") return "browser_get";
  return null;
}

// Family grouping for the tool-surface RFC's per-family invocation view. Names
// mirror the RFC's families; anything unmatched reports under its own name.
function toolFamily(toolName: string): string {
  if (toolName.startsWith("code_")) return "code";
  if (toolName.startsWith("attention_")) return "attention";
  if (toolName.startsWith("browser_")) return "browser";
  if (toolName.startsWith("lsp_")) return "lsp";
  if (toolName.startsWith("source_patch_")) return "source_patch";
  if (toolName.startsWith("recall_")) return "recall";
  if (toolName.startsWith("knowledge_")) return "knowledge";
  if (toolName.startsWith("precedent_")) return "precedent";
  if (toolName.startsWith("workbench_")) return "workbench";
  if (toolName.startsWith("worker_results_")) return "worker_results";
  if (toolName.startsWith("subagent_")) return "subagent";
  if (toolName.startsWith("task_")) return "task_ledger";
  if (toolName.startsWith("tape_")) return "tape";
  if (toolName.startsWith("git_")) return "git";
  if (toolName.startsWith("obs_")) return "obs";
  if (toolName.startsWith("agent_")) return "agent";
  if (toolName.startsWith("reasoning_")) return "reasoning";
  if (toolName.startsWith("iteration_")) return "iteration";
  if (toolName.endsWith("_plan_map") || toolName.endsWith("_plan_ticket")) return "plan_map";
  if (toolName === "record_fog" || toolName === "graduate_fog") return "plan_map";
  if (toolName === "get_goal" || toolName === "update_goal") return "goal";
  return toolName;
}

const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    tape: { type: "string" },
  },
});

const tapeDir = resolve(process.cwd(), args.tape ?? ".brewva/tape");
if (!existsSync(tapeDir)) {
  console.error(`tape directory not found: ${tapeDir} (pass --tape <dir>)`);
  process.exit(1);
}

const tapeFiles = readdirSync(tapeDir)
  .filter((name) => name.endsWith(".jsonl"))
  .toSorted((left, right) => left.localeCompare(right));

// --- skill selection ---
let selectionReceipts = 0;
let offersTotal = 0;
let offersAdopted = 0;
const offerReasonCounts = new Map<string, number>();
// --- task stall ---
let stuckDetected = 0;
const stallIdleMs: number[] = [];
const stallDecisionCounts = new Map<string, number>();
const stallRationaleSamples: string[] = [];
// --- output distiller ---
const distillerReceiptCounts = new Map<string, number>();
const distillerRatios = new Map<string, number[]>();
let distillerTruncated = 0;
let distillerReceiptsTotal = 0;
const eligibleToolCommits = new Map<string, number>();
// --- tool surface (per-family invocation) ---
const managedToolCommits = new Map<string, number>();
const hostToolCommits = new Map<string, number>();
const managedToolNameSet = new Set<string>(MANAGED_BREWVA_TOOL_NAMES);
let totalEvents = 0;

for (const file of tapeFiles) {
  const lines = readFileSync(join(tapeDir, file), "utf8").split("\n");
  const events: TapeEvent[] = [];
  for (const line of lines) {
    if (!line) continue;
    const event = decodeTapeLine(line);
    if (event) events.push(event);
  }
  totalEvents += events.length;

  // Committed reads (with targets + timestamps) feed skill adoption matching.
  const committedReads: Array<{ timestamp: number; target: string }> = [];
  for (const event of events) {
    if (event.kind !== "tool.committed") continue;
    const call = isRecord(event.payload.call) ? event.payload.call : undefined;
    const toolName = readString(call?.toolName);
    if (!toolName) continue;
    if (managedToolNameSet.has(toolName)) {
      bump(managedToolCommits, toolName);
    } else {
      bump(hostToolCommits, toolName);
    }
    const group = distillerStrategyGroup(toolName);
    if (group) bump(eligibleToolCommits, group);
    if (!READ_TOOL_NAMES.has(toolName)) continue;
    const callArgs = isRecord(call?.args) ? call.args : undefined;
    const target =
      readString(callArgs?.uri) ??
      readString(callArgs?.path) ??
      readString(callArgs?.file_path) ??
      readString(callArgs?.filePath);
    if (target) committedReads.push({ timestamp: event.timestamp, target });
  }

  for (const event of events) {
    if (event.kind === "skill.selection.recorded") {
      selectionReceipts += 1;
      const rendered = Array.isArray(event.payload.renderedSkillReasons)
        ? event.payload.renderedSkillReasons
        : [];
      for (const entry of rendered) {
        if (!isRecord(entry)) continue;
        offersTotal += 1;
        const reasons = Array.isArray(entry.reasons) ? entry.reasons : [];
        for (const reason of reasons) {
          const label = readString(reason);
          if (label) bump(offerReasonCounts, label);
        }
        const filePath = readString(entry.filePath);
        const adopted =
          filePath !== undefined &&
          committedReads.some(
            (read) =>
              read.timestamp >= event.timestamp &&
              readTargetMatchesSkillFile(read.target, filePath),
          );
        if (adopted) offersAdopted += 1;
      }
      continue;
    }
    if (event.kind === "task.stuck.detected") {
      stuckDetected += 1;
      const idleMs = readNumber(event.payload.idleMs);
      if (idleMs !== undefined) stallIdleMs.push(idleMs);
      continue;
    }
    if (event.kind === "task.stall.adjudicated") {
      const decision = readString(event.payload.decision) ?? "(unknown)";
      const source = readString(event.payload.source) ?? "(unknown)";
      bump(stallDecisionCounts, `${decision} [${source}]`);
      const rationale = readString(event.payload.rationale);
      if (rationale && stallRationaleSamples.length < 3) {
        stallRationaleSamples.push(rationale);
      }
      continue;
    }
    if (event.kind === "tool_output_distilled") {
      distillerReceiptsTotal += 1;
      const strategy = readString(event.payload.strategy) ?? "(unknown)";
      bump(distillerReceiptCounts, strategy);
      const ratio = readNumber(event.payload.compressionRatio);
      if (ratio !== undefined) {
        const bucket = distillerRatios.get(strategy) ?? [];
        bucket.push(ratio);
        distillerRatios.set(strategy, bucket);
      }
      if (event.payload.truncated === true) distillerTruncated += 1;
    }
  }
}

console.log("# Advisory receipt calibration report");
console.log(`tape: ${tapeDir}`);
console.log(`sessions: ${tapeFiles.length}  events: ${totalEvents}`);
console.log(
  "note: a thin corpus BOUNDS conclusions — zero firings means unexercised, not unnecessary.",
);

console.log("\n## skill selection (`skill.selection.recorded`)");
if (selectionReceipts === 0) {
  console.log("  (no receipts in this corpus)");
} else {
  console.log(`  receipts: ${selectionReceipts}  offered SkillCards: ${offersTotal}`);
  console.log(
    `  adopted (SKILL.md read after offer): ${offersAdopted} (${percent(offersAdopted, offersTotal)})`,
  );
  console.log("  offer reasons:");
  for (const line of formatCounts(offerReasonCounts)) console.log(line);
}

console.log("\n## task stall (`task.stuck.detected` -> `task.stall.adjudicated`)");
if (stuckDetected === 0 && stallDecisionCounts.size === 0) {
  console.log("  (no stall detections in this corpus)");
} else {
  console.log(`  stuck detections: ${stuckDetected}`);
  if (stallIdleMs.length > 0) {
    console.log(`  idleMs: ${summarizeRatios(stallIdleMs)}`);
  }
  console.log("  adjudications by decision [source]:");
  for (const line of formatCounts(stallDecisionCounts)) console.log(line);
  for (const rationale of stallRationaleSamples) {
    console.log(`    rationale sample: ${rationale}`);
  }
}

console.log("\n## output distiller (`tool_output_distilled`)");
if (distillerReceiptsTotal === 0) {
  console.log("  (no distillation receipts in this corpus)");
} else {
  console.log(
    `  receipts: ${distillerReceiptsTotal}  truncated: ${distillerTruncated} (${percent(distillerTruncated, distillerReceiptsTotal)})`,
  );
  console.log("  firings by strategy (compression = summary/raw tokens, lower is better):");
  for (const [strategy, count] of [...distillerReceiptCounts.entries()].toSorted(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )) {
    console.log(
      `    ${String(count).padStart(5)}  ${strategy}  ${summarizeRatios(distillerRatios.get(strategy) ?? [])}`,
    );
  }
}
console.log("  eligible-tool commits (denominator for firing rate):");
if (eligibleToolCommits.size === 0) {
  console.log("    (none)");
} else {
  for (const line of formatCounts(eligibleToolCommits)) console.log(line);
}

console.log("\n## tool surface (per-family invocation — tool-surface RFC view)");
interface FamilyRow {
  family: string;
  surfaces: Set<string>;
  toolCount: number;
  committed: number;
  usedTools: Set<string>;
}
const familyRows = new Map<string, FamilyRow>();
for (const toolName of MANAGED_BREWVA_TOOL_NAMES) {
  const surface = BREWVA_TOOL_SURFACE_BY_NAME[toolName] ?? "unknown";
  // The RFC measures the model-facing surface; control-plane/operator tools are
  // not in the per-turn payload, so they are excluded from this view.
  if (surface !== "base" && surface !== "skill") continue;
  const family = toolFamily(toolName);
  const row = familyRows.get(family) ?? {
    family,
    surfaces: new Set<string>(),
    toolCount: 0,
    committed: 0,
    usedTools: new Set<string>(),
  };
  row.surfaces.add(surface);
  row.toolCount += 1;
  const committed = managedToolCommits.get(toolName) ?? 0;
  row.committed += committed;
  if (committed > 0) row.usedTools.add(toolName);
  familyRows.set(family, row);
}
const sortedFamilies = [...familyRows.values()].toSorted(
  (left, right) => right.committed - left.committed || left.family.localeCompare(right.family),
);
console.log("  family [surfaces] tools=N committed=N distinct_used=N");
for (const row of sortedFamilies) {
  const surfaces = [...row.surfaces].toSorted((a, b) => a.localeCompare(b)).join("+");
  console.log(
    `    ${row.family.padEnd(16)} [${surfaces}] tools=${String(row.toolCount).padStart(2)} committed=${String(row.committed).padStart(4)} distinct_used=${row.usedTools.size}`,
  );
}
const zeroFamilies = sortedFamilies.filter((row) => row.committed === 0).length;
console.log(
  `  families with zero committed calls in this corpus: ${zeroFamilies}/${sortedFamilies.length}`,
);
console.log("  host-plane tool commits (two-plane comparison):");
if (hostToolCommits.size === 0) {
  console.log("    (none)");
} else {
  for (const line of formatCounts(hostToolCommits)) console.log(line);
}
