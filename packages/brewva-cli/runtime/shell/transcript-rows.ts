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

const TOOL_ID_SEPARATOR = ":tool:";
const ASSISTANT_ID_SEPARATOR = ":assistant:";

/**
 * Turn scope of a tool message id (`wire:<session>:<turn>:tool:<callId>` →
 * `wire:<session>:<turn>`). Two tool messages share a turn iff their scopes match.
 * Uses the `:tool:` sentinel so it never depends on session/turn id internals.
 */
function toolTurnScope(id: string): string | undefined {
  const index = id.indexOf(TOOL_ID_SEPARATOR);
  return index >= 0 ? id.slice(0, index) : undefined;
}

/**
 * Turn+attempt scope of an assistant message id
 * (`wire:<session>:<turn>:<attempt>:assistant:…` → `wire:<session>:<turn>:<attempt>`).
 * All assistant segments of one attempt share a scope; only the last shows the byline.
 */
function assistantTurnScope(id: string): string | undefined {
  const index = id.indexOf(ASSISTANT_ID_SEPARATOR);
  return index >= 0 ? id.slice(0, index) : undefined;
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
  // First pass: last assistant index per (turn, attempt) scope. An id with no
  // parseable scope keys on itself, so it still shows its own label.
  const lastAssistantIndexByScope = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role !== "assistant") return;
    lastAssistantIndexByScope.set(assistantTurnScope(message.id) ?? message.id, index);
  });

  const hints = new Map<string, TranscriptRowHint>();
  messages.forEach((message, index) => {
    let compactTop = false;
    if (message.role === "tool") {
      const scope = toolTurnScope(message.id);
      const previous = index > 0 ? messages[index - 1] : undefined;
      // Pack only against an immediately-preceding same-turn tool row that is
      // guaranteed to render as a single line; anything that might render as a block
      // keeps a gap below it. An unparseable scope (undefined) never packs, the safe
      // default.
      compactTop =
        scope !== undefined &&
        previous !== undefined &&
        previous.role === "tool" &&
        toolTurnScope(previous.id) === scope &&
        rendersAsSingleLine(previous);
    }
    const showAssistantLabel =
      message.role === "assistant" &&
      lastAssistantIndexByScope.get(assistantTurnScope(message.id) ?? message.id) === index;
    hints.set(message.id, { compactTop, showAssistantLabel });
  });

  return hints;
}
