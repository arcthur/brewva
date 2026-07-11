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
//
// Security: RFC markdown is DATA, not code. A gate is therefore parsed into an
// argv and spawned directly (never handed to a shell), and it is read ONLY from
// the note's Promotion section. Every token must match a conservative charset so
// a gate string can never carry shell metacharacters (`;`, `|`, `$`, backticks,
// redirects, …) into execution — the readiness runner spawns `argv` verbatim.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PROMOTION_GATE_PATTERN = /^\s*-\s+gate:\s+`([^`]+)`\s*$/;

/** Gates must be repo-runnable, deterministic entrypoints. */
export const ALLOWED_GATE_LEADS = [
  ["bun", "test"],
  ["bun", "run"],
] as const;

// A gate token is a bare program word, subcommand, repo-relative path, package
// script name (`test:dist`), or long flag (`--run`). The charset deliberately
// excludes every shell metacharacter and whitespace, so a parsed argv can never
// re-expand into more than the words the note literally wrote.
const SAFE_GATE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;
const SAFE_GATE_FLAG = /^--[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

export interface PromotionGate {
  readonly command: string;
  /** Validated argv to spawn directly, or null when the command is unsafe/malformed. */
  readonly argv: readonly string[] | null;
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

function isSafeGateToken(token: string): boolean {
  return SAFE_GATE_TOKEN.test(token) || SAFE_GATE_FLAG.test(token);
}

/**
 * Parse a gate command string into a validated argv, or null when it is not a
 * shell-free `bun test …` / `bun run …` invocation. Rejection is total: a single
 * unsafe token (anything carrying a shell metacharacter or whitespace beyond the
 * word delimiter) fails the whole command, so nothing is ever handed to a shell.
 */
export function parseGateCommand(command: string): readonly string[] | null {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length < 3) {
    return null;
  }
  const leadMatches = ALLOWED_GATE_LEADS.some(
    ([program, subcommand]) => tokens[0] === program && tokens[1] === subcommand,
  );
  if (!leadMatches) {
    return null;
  }
  if (!tokens.every((token) => isSafeGateToken(token))) {
    return null;
  }
  return tokens;
}

export function isAllowedGateCommand(command: string): boolean {
  return parseGateCommand(command) !== null;
}

/** The line range of the note's `## Promotion …` section, or null when absent. */
function findPromotionSectionLineRange(
  lines: readonly string[],
): { start: number; end: number } | null {
  const start = lines.findIndex((line) => /^##\s+Promotion\b/.test(line));
  if (start === -1) {
    return null;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return { start, end };
}

/**
 * Extract gate declarations, scanning ONLY the Promotion section (a `- gate:`
 * line anywhere else in the note is prose about gates, not a runnable gate). Line
 * numbers stay absolute (1-indexed) so diagnostics point at the real file line.
 */
export function extractPromotionGates(markdown: string): PromotionGate[] {
  const lines = markdown.split("\n");
  const range = findPromotionSectionLineRange(lines);
  if (!range) {
    return [];
  }
  const gates: PromotionGate[] = [];
  for (let index = range.start + 1; index < range.end; index += 1) {
    const match = lines[index]?.match(PROMOTION_GATE_PATTERN);
    const command = match?.[1]?.trim();
    if (command) {
      gates.push({ command, argv: parseGateCommand(command), line: index + 1 });
    }
  }
  return gates;
}

function readPromotionSection(markdown: string): string | null {
  const lines = markdown.split("\n");
  const range = findPromotionSectionLineRange(lines);
  return range ? lines.slice(range.start + 1, range.end).join("\n") : null;
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
