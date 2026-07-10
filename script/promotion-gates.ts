// Shared parser for machine-decidable promotion gates (auto-research assembly,
// step 3). An active research note may declare, inside its promotion-criteria
// section, gate lines of the form:
//
//   - gate: `bun test test/fitness/tool-surface-ceiling.fitness.test.ts`
//
// A gate is a runnable command whose exit code decides that criterion; prose
// criteria stay prose (only mechanically checkable criteria get gates — a gate
// that cannot actually run would be axiom 19's unchecked promise). The
// readiness script lists and optionally runs them; a docs fitness keeps every
// declared gate well-formed. Promotion itself stays a human act: the readiness
// table is a report, never an auto-promotion trigger.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PROMOTION_GATE_PATTERN = /^\s*-\s+gate:\s+`([^`]+)`\s*$/;

/** Gates must be repo-runnable, deterministic entrypoints. */
export const ALLOWED_GATE_PREFIXES = ["bun test ", "bun run "] as const;

export interface PromotionGate {
  readonly command: string;
  readonly line: number;
}

export interface ActiveNotePromotionReadiness {
  readonly file: string;
  readonly title: string;
  readonly hasPromotionSection: boolean;
  readonly gates: readonly PromotionGate[];
  /** Top-level promotion bullets that are NOT gate lines (human criteria). */
  readonly proseCriteria: number;
}

export function isAllowedGateCommand(command: string): boolean {
  return ALLOWED_GATE_PREFIXES.some((prefix) => command.startsWith(prefix));
}

export function extractPromotionGates(markdown: string): PromotionGate[] {
  const gates: PromotionGate[] = [];
  const lines = markdown.split("\n");
  for (const [index, line] of lines.entries()) {
    const match = line.match(PROMOTION_GATE_PATTERN);
    const command = match?.[1]?.trim();
    if (command) {
      gates.push({ command, line: index + 1 });
    }
  }
  return gates;
}

function readPromotionSection(markdown: string): string | null {
  const match = markdown.match(/^##\s+Promotion[^\n]*\n([\s\S]*?)(?=^##\s|\n$(?![\s\S]))/m);
  return match?.[1] ?? null;
}

function countProseCriteria(section: string): number {
  return section
    .split("\n")
    .filter((line) => /^-\s+/.test(line) && !PROMOTION_GATE_PATTERN.test(line)).length;
}

function readTitle(markdown: string): string {
  const heading = markdown.split("\n").find((line) => line.startsWith("# "));
  return heading ? heading.slice(2).trim() : "(untitled)";
}

export function listActiveNotePromotionReadiness(
  activeDir: string,
): ActiveNotePromotionReadiness[] {
  return readdirSync(activeDir)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .toSorted((left, right) => left.localeCompare(right))
    .map((name) => {
      const markdown = readFileSync(join(activeDir, name), "utf8");
      const section = readPromotionSection(markdown);
      return {
        file: name,
        title: readTitle(markdown),
        hasPromotionSection: section !== null,
        gates: extractPromotionGates(markdown),
        proseCriteria: section ? countProseCriteria(section) : 0,
      };
    });
}
