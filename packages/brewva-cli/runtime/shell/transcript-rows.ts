import type { CliShellTranscriptMessage } from "../../src/shell/domain/transcript.js";

/**
 * Per-message render hint projected from the flat transcript message list
 * (Pillars 1b + 3a of the streaming-transcript legibility work).
 *
 * - `compactTop`: this tool message directly follows another tool message of the
 *   same turn, so its single-line row collapses the top margin and packs into a
 *   list instead of pulling an empty line.
 * - `showAssistantLabel`: this assistant message is the LAST segment of its
 *   (turn, attempt) scope, so the `▣` byline renders once per turn instead of once
 *   per committed segment. Meaningful only for assistant messages; false otherwise.
 *
 * A hint map (not a grouped row structure) is deliberate: the transcript keeps its
 * message-keyed `<For>` so structurally-shared message references are reused and the
 * DOM is never rebuilt per streaming frame. Packing is achieved by `compactTop`
 * alone — row wrapper boxes carry no margin, so a zero top margin visually joins the
 * rows without a wrapper.
 */
export interface TranscriptRowHint {
  readonly compactTop: boolean;
  readonly showAssistantLabel: boolean;
}

const DEFAULT_TRANSCRIPT_ROW_HINT: TranscriptRowHint = {
  compactTop: false,
  showAssistantLabel: false,
};

/** Lookup with the safe default for ids absent from the map (e.g. mid-stream races). */
export function transcriptRowHint(
  hints: ReadonlyMap<string, TranscriptRowHint>,
  id: string,
): TranscriptRowHint {
  return hints.get(id) ?? DEFAULT_TRANSCRIPT_ROW_HINT;
}

/**
 * Turn+attempt scope for assistant label dedupe, from the STRUCTURAL `turnId` /
 * `attemptId` fields (filled by wire-fold) — never parsed from the id. A channel
 * reply turnId can itself embed `:tool:` / `:assistant:` sentinels (see
 * channel-reply-writer), so a substring split would mis-cut and merge unrelated
 * turns. `\u0000` joins the two components (neither can contain a null byte); a
 * message with no structural turnId keys on its own id (own scope → always labels).
 */
function assistantLabelScope(message: CliShellTranscriptMessage): string {
  return message.turnId !== undefined
    ? `${message.turnId}\u0000${message.attemptId ?? ""}`
    : message.id;
}

// Tools whose row is ALWAYS a single line regardless of status/payload/details —
// only `read` today (ReadToolView unconditionally renders an InlineTool). A follower
// packs only against one of these, so an inline row can never sit flush under a
// block-rendered tool. An allowlist (not a denylist of block-capable tools) is
// required because GenericToolView also renders a bordered block for errored /
// details-mode / subagent / MCP / custom tools whose names are open-ended and could
// never be fully enumerated; erring toward under-packing anything not known-inline is
// the safe direction (a missing pack is a spare blank line, a wrong pack butts an
// inline row against a block's border).
const ALWAYS_INLINE_TOOL_NAMES: ReadonlySet<string> = new Set(["read"]);

function toolNameOfMessage(message: CliShellTranscriptMessage): string | undefined {
  for (const part of message.parts) {
    if (part.type === "tool") {
      return part.toolName;
    }
  }
  return undefined;
}

function rendersAsSingleLine(message: CliShellTranscriptMessage): boolean {
  const toolName = toolNameOfMessage(message);
  return toolName !== undefined && ALWAYS_INLINE_TOOL_NAMES.has(toolName);
}

/**
 * Project per-message render hints. Pure and deterministic: identical input yields
 * an identical map, so the transcript's message-keyed `<For>` never churns.
 */
export function projectTranscriptRowHints(
  messages: readonly CliShellTranscriptMessage[],
): Map<string, TranscriptRowHint> {
  // First pass: last assistant index per (turn, attempt) scope. A message with no
  // structural turnId keys on its own id, so it still shows its own label.
  const lastAssistantIndexByScope = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role !== "assistant") return;
    lastAssistantIndexByScope.set(assistantLabelScope(message), index);
  });

  const hints = new Map<string, TranscriptRowHint>();
  messages.forEach((message, index) => {
    let compactTop = false;
    if (message.role === "tool") {
      const turnId = message.turnId;
      const previous = index > 0 ? messages[index - 1] : undefined;
      // Pack only against an immediately-preceding same-turn tool row that is
      // guaranteed to render as a single line; anything that might render as a block
      // keeps a gap below it. Same-turn is compared on the STRUCTURAL turnId (never
      // parsed from the id); a message with no turnId (undefined) never packs, the
      // safe default.
      compactTop =
        turnId !== undefined &&
        previous !== undefined &&
        previous.role === "tool" &&
        previous.turnId === turnId &&
        rendersAsSingleLine(previous);
    }
    const showAssistantLabel =
      message.role === "assistant" &&
      lastAssistantIndexByScope.get(assistantLabelScope(message)) === index;
    hints.set(message.id, { compactTop, showAssistantLabel });
  });

  return hints;
}
