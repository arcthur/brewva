import { TOOL_RESULT_RECORDED_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";

/** Minimal shape of a recorded tool-result event the distiller reads from tape. */
export interface RdpToolResultEvent {
  readonly sessionId: string;
  readonly timestamp: number;
  readonly type: string;
  readonly payload?: {
    readonly toolName?: unknown;
    readonly failureClass?: unknown;
    readonly verdict?: unknown;
  };
}

export interface RdpFailureSignal {
  readonly toolName: string;
  readonly failureClass: string;
  readonly sessionId: string;
  readonly timestamp: number;
}

/**
 * Extract genuine tool failures from recorded tool-result events. Pure: callers
 * supply replay-derived events; non-result events and non-failures are filtered
 * out by the authoritative outcome verdict ("pass" | "fail" | "inconclusive").
 */
export function collectRdpFailureSignals(
  events: readonly RdpToolResultEvent[],
): RdpFailureSignal[] {
  const signals: RdpFailureSignal[] = [];
  for (const event of events) {
    if (event.type !== TOOL_RESULT_RECORDED_EVENT_TYPE) continue;
    // The outcome verdict is the authoritative failure signal — an allowlist of
    // one value — so non-failure classes are never mistaken for precedent.
    if (event.payload?.verdict !== "fail") continue;
    const toolName = event.payload?.toolName;
    const failureClass = event.payload?.failureClass;
    if (typeof toolName !== "string" || toolName.length === 0) continue;
    if (typeof failureClass !== "string" || failureClass.length === 0) continue;
    signals.push({
      toolName,
      failureClass,
      sessionId: event.sessionId,
      timestamp: event.timestamp,
    });
  }
  return signals;
}

export interface RdpFailurePattern {
  readonly toolName: string;
  readonly failureClass: string;
  readonly occurrences: number;
  readonly sessionIds: readonly string[];
  readonly firstSeen: number;
  readonly lastSeen: number;
}

export interface DistillFailurePatternsOptions {
  readonly minOccurrences?: number;
}

interface FailureGroup {
  toolName: string;
  failureClass: string;
  timestamps: number[];
  sessions: Set<string>;
}

/**
 * Group failure signals into recurring patterns. Only patterns seen at least
 * `minOccurrences` times (default 2) survive, so one-off failures are not turned
 * into precedent. Deterministic ordering: most frequent first.
 */
export function distillFailurePatterns(
  signals: readonly RdpFailureSignal[],
  options: DistillFailurePatternsOptions = {},
): RdpFailurePattern[] {
  const minOccurrences = options.minOccurrences ?? 2;
  const groups = new Map<string, FailureGroup>();
  for (const signal of signals) {
    // JSON-encode the pair so distinct (toolName, failureClass) values — even
    // ones containing separators — never collide into one group.
    const key = JSON.stringify([signal.toolName, signal.failureClass]);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        toolName: signal.toolName,
        failureClass: signal.failureClass,
        timestamps: [],
        sessions: new Set<string>(),
      };
      groups.set(key, group);
    }
    group.timestamps.push(signal.timestamp);
    group.sessions.add(signal.sessionId);
  }
  const patterns: RdpFailurePattern[] = [];
  for (const group of groups.values()) {
    if (group.timestamps.length < minOccurrences) continue;
    // Fold instead of Math.min(...spread) so very frequent failures cannot blow
    // the call stack.
    let firstSeen = Number.POSITIVE_INFINITY;
    let lastSeen = Number.NEGATIVE_INFINITY;
    for (const timestamp of group.timestamps) {
      if (timestamp < firstSeen) firstSeen = timestamp;
      if (timestamp > lastSeen) lastSeen = timestamp;
    }
    patterns.push({
      toolName: group.toolName,
      failureClass: group.failureClass,
      occurrences: group.timestamps.length,
      sessionIds: [...group.sessions].toSorted(),
      firstSeen,
      lastSeen,
    });
  }
  return patterns.toSorted(
    (left, right) =>
      right.occurrences - left.occurrences || left.toolName.localeCompare(right.toolName),
  );
}

export interface RdpCandidateDocument {
  readonly slug: string;
  readonly relativePath: string;
  readonly markdown: string;
}

export interface RenderRdpCandidateOptions {
  /** Absolute date stamp (YYYY-MM-DD); passed in to keep rendering deterministic. */
  readonly generatedAt: string;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
}

/**
 * Render a recurring failure pattern as an investigation-record-shaped promotion
 * candidate for the warm `.brewva/knowledge/**` layer. It is explicitly a
 * promotion candidate, never an active solution record; promotion to
 * `docs/solutions/**` runs only through `knowledge_capture` with human review.
 */
export function renderRdpCandidate(
  pattern: RdpFailurePattern,
  options: RenderRdpCandidateOptions,
): RdpCandidateDocument {
  const slug = `${slugify(pattern.toolName)}-${slugify(pattern.failureClass)}`;
  const relativePath = `.brewva/knowledge/rdp/${slug}.md`;
  const title = `Recurring ${pattern.failureClass} from ${pattern.toolName}`;
  const markdown = [
    "---",
    `id: rdp-${options.generatedAt}-${slug}`,
    `title: ${title}`,
    "kind: promotion_candidate",
    "status: promotion_candidate",
    "problem_kind: bugfix",
    `tool: ${pattern.toolName}`,
    `failure_class: ${pattern.failureClass}`,
    `occurrences: ${pattern.occurrences}`,
    `session_count: ${pattern.sessionIds.length}`,
    `distilled_at: ${options.generatedAt}`,
    "---",
    "",
    `# ${title}`,
    "",
    "> Replay-distilled promotion candidate. Not an active solution record. Promote",
    "> through knowledge_capture with an investigation_record and human review.",
    "",
    "## Problem",
    "",
    `\`${pattern.toolName}\` repeatedly recorded the failure class \`${pattern.failureClass}\`.`,
    "",
    "## Symptoms",
    "",
    `- ${pattern.occurrences} occurrences across ${pattern.sessionIds.length} session(s).`,
    `- sessions: ${pattern.sessionIds.join(", ")}`,
    "",
    "## Failed Attempts",
    "",
    `- Recurring \`${pattern.failureClass}\` failures from \`${pattern.toolName}\` are the failed-attempt signal distilled from tape.`,
    "",
    "## Observed Resolution",
    "",
    "_To be completed by a human reviewer or a knowledge_capture pass before promotion._",
    "",
    "## References",
    "",
    ...pattern.sessionIds.map((sessionId) => `- tape session ${sessionId}`),
    "",
  ].join("\n");
  return { slug, relativePath, markdown };
}
