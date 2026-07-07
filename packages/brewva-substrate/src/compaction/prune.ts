import { shortSha256Hex } from "@brewva/brewva-std/hash";
import type { SessionPruneOperation } from "@brewva/brewva-vocabulary/session";
import {
  estimateBrewvaCompactionMessageTokens,
  estimateBrewvaCompactionTokens,
} from "./transcript-format.js";

/**
 * Deterministic, pure pre-compaction prune over the LLM summarizer's input
 * messages. It removes redundancy the summary would otherwise pay for verbatim,
 * WITHOUT touching the tape (the caller records a `session.pre_compact_prune`
 * receipt) and WITHOUT touching the retained tail (the cut point rebuilds that
 * from entries in the session store, not from this array). Three operations,
 * each entry gets at most one, so they are complementary rather than
 * overlapping:
 *
 * - dedupe: identical tool-result bodies (>= `dedupeMinChars`) anywhere in the
 *   input collapse to a one-liner pointing at the most recent occurrence.
 * - image_strip: an old multimodal tool result drops its image blocks (keeping
 *   text) — images are large and low-signal for a text summary.
 * - inform_replace: an old, substantial text tool result collapses to a
 *   metadata one-liner (tool name + size), built only from typed fields.
 *
 * "old" means outside the tail-protection token window (walked from the end);
 * dedupe is position-independent because a duplicate is pure redundancy wherever
 * it sits. Protected tools (curated memory / recall) are never pruned.
 */

const DEFAULT_DEDUPE_MIN_CHARS = 200;
const DEFAULT_INFORM_REPLACE_MIN_CHARS = 200;
const DEFAULT_TAIL_PROTECT_TOKENS = 40_000;
const DIGEST_LENGTH = 12;

/**
 * Fallback protected set for standalone use: model-curated or load-bearing
 * memory tools whose results must never be pruned. The lifecycle passes the
 * canonical list from `infrastructure.contextBudget.compaction.protectedTools`
 * via `PruneOptions.protectedTools`; this literal only mirrors that default so
 * the pure function stays usable on its own (e.g. in tests).
 */
const DEFAULT_PROTECTED_TOOLS: readonly string[] = [
  "workbench_note",
  "workbench_evict",
  "workbench_undo_evict",
  "workbench_compact",
  "recall_search",
  "recall_curate",
  "tape_handoff",
];

// The agent protocol stores image tool-result blocks as `type: "image"`; the
// provider-wire variants (image_url / input_image) are normalized away before
// storage, so they never reach the summarizer input. A set keeps the membership
// check cheap and leaves room for a future stored multimodal block type.
const IMAGE_BLOCK_TYPES: ReadonlySet<string> = new Set(["image"]);

export interface PruneOptions {
  /** Tool names whose results are never pruned; defaults to the curated set. */
  readonly protectedTools?: readonly string[];
  readonly dedupeMinChars?: number;
  readonly informReplaceMinChars?: number;
  readonly tailProtectTokens?: number;
  readonly informReplace?: boolean;
  readonly stripImages?: boolean;
}

export interface PruneResult {
  readonly messages: readonly unknown[];
  /** What was deduped/replaced/stripped — the tape-receipt operation shape. */
  readonly operations: readonly SessionPruneOperation[];
  /** Estimated LLM-summary-input tokens removed (serialized original minus pruned). */
  readonly tokensSaved: number;
}

interface ToolResultView {
  readonly toolName: string;
  readonly toolCallId: string | undefined;
  readonly content: unknown;
}

function asToolResult(message: unknown): ToolResultView | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const record = message as {
    role?: unknown;
    toolName?: unknown;
    toolCallId?: unknown;
    content?: unknown;
  };
  if (record.role !== "toolResult") {
    return null;
  }
  return {
    toolName: typeof record.toolName === "string" ? record.toolName : "tool",
    toolCallId: typeof record.toolCallId === "string" ? record.toolCallId : undefined,
    content: record.content,
  };
}

function toolResultBodyText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object") {
      const record = part as { type?: unknown; text?: unknown };
      if (record.type === "text" && typeof record.text === "string") {
        parts.push(record.text);
      }
    }
  }
  return parts.join("");
}

function countImageBlocks(content: unknown): number {
  if (!Array.isArray(content)) {
    return 0;
  }
  let count = 0;
  for (const part of content) {
    if (part && typeof part === "object") {
      const type = (part as { type?: unknown }).type;
      if (typeof type === "string" && IMAGE_BLOCK_TYPES.has(type)) {
        count += 1;
      }
    }
  }
  return count;
}

function stripImageBlocks(content: unknown, imageCount: number): unknown[] {
  const kept: unknown[] = Array.isArray(content)
    ? content.filter((part) => {
        if (!part || typeof part !== "object") {
          return true;
        }
        const type = (part as { type?: unknown }).type;
        return !(typeof type === "string" && IMAGE_BLOCK_TYPES.has(type));
      })
    : [];
  kept.push({ type: "text", text: `[${imageCount} image(s) stripped by pre-compaction prune]` });
  return kept;
}

function withReplacedContent(message: unknown, content: unknown): unknown {
  return { ...(message as Record<string, unknown>), content };
}

function digestOf(body: string): string {
  return body.length > 0 ? shortSha256Hex(body, DIGEST_LENGTH) : "";
}

/**
 * Index of the first message inside the tail-protection window, walking from the
 * end and accumulating estimated tokens until `tailProtectTokens` is reached.
 * Messages before this index are "old" and eligible for inform-replace/strip.
 */
function firstProtectedIndex(messages: readonly unknown[], tailProtectTokens: number): number {
  let tokens = 0;
  let index = messages.length;
  for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
    tokens += estimateBrewvaCompactionMessageTokens(messages[cursor]);
    index = cursor;
    if (tokens >= tailProtectTokens) {
      break;
    }
  }
  return index;
}

export function pruneCompactionInput(
  messages: readonly unknown[],
  options: PruneOptions = {},
): PruneResult {
  const dedupeMinChars = options.dedupeMinChars ?? DEFAULT_DEDUPE_MIN_CHARS;
  const informReplaceMinChars = options.informReplaceMinChars ?? DEFAULT_INFORM_REPLACE_MIN_CHARS;
  const tailProtectTokens = options.tailProtectTokens ?? DEFAULT_TAIL_PROTECT_TOKENS;
  const informReplace = options.informReplace ?? true;
  const stripImages = options.stripImages ?? true;
  const protectedTools = new Set(options.protectedTools ?? DEFAULT_PROTECTED_TOOLS);

  const protectedFrom = firstProtectedIndex(messages, tailProtectTokens);

  // Pass 1: hash every substantial, prunable tool-result body and record the
  // newest occurrence per hash. Earlier occurrences of a repeated hash are
  // duplicates. Protected tools are excluded from hashing (never pruned).
  const hashByIndex = new Map<number, string>();
  const newestIndexByHash = new Map<string, number>();
  for (let index = 0; index < messages.length; index += 1) {
    const toolResult = asToolResult(messages[index]);
    if (!toolResult || protectedTools.has(toolResult.toolName)) {
      continue;
    }
    const body = toolResultBodyText(toolResult.content);
    if (body.length < dedupeMinChars) {
      continue;
    }
    const hash = shortSha256Hex(body, DIGEST_LENGTH);
    hashByIndex.set(index, hash);
    newestIndexByHash.set(hash, index);
  }

  // Pass 2: build the pruned messages + operations. Each entry takes at most one
  // operation, priority: dedupe (duplicate) > inform_replace > image_strip. The
  // inform_replace-before-image_strip order is what makes the pass idempotent.
  const operations: SessionPruneOperation[] = [];
  const prunedMessages = messages.map((message, index) => {
    const toolResult = asToolResult(message);
    if (!toolResult || protectedTools.has(toolResult.toolName)) {
      return message;
    }
    const body = toolResultBodyText(toolResult.content);
    const digest = digestOf(body);
    const base = {
      index,
      toolName: toolResult.toolName,
      ...(toolResult.toolCallId ? { toolCallId: toolResult.toolCallId } : {}),
      originalDigest: digest,
    };

    const hash = hashByIndex.get(index);
    if (hash !== undefined && newestIndexByHash.get(hash) !== index) {
      // Index-free text: positions mean nothing to the summarizer. The kept copy
      // is recoverable by matching `originalDigest` across the receipt operations.
      const replacement =
        "[duplicate of an earlier identical tool result — omitted by pre-compaction prune]";
      operations.push({ ...base, operation: "dedupe", replacementSummary: replacement });
      return withReplacedContent(message, [{ type: "text", text: replacement }]);
    }

    if (index >= protectedFrom) {
      return message;
    }

    // Inform-replace substantial old text FIRST so the pruned state is a stable
    // one-liner: a re-prune finds it below the threshold and does nothing. Large
    // multimodal results are collapsed here too (their images go with the body),
    // which is what keeps the pass idempotent — see the image_strip note below.
    if (informReplace && body.length >= informReplaceMinChars) {
      const tokens = estimateBrewvaCompactionMessageTokens(message);
      const replacement = `[tool:${toolResult.toolName}] ~${tokens} tokens elided by pre-compaction prune`;
      operations.push({ ...base, operation: "inform_replace", replacementSummary: replacement });
      return withReplacedContent(message, [{ type: "text", text: replacement }]);
    }

    // Image-strip only reaches small-text image results (large-text ones were
    // inform-replaced above), so the kept text stays below the replace threshold
    // and a re-prune is a no-op.
    if (stripImages) {
      const imageCount = countImageBlocks(toolResult.content);
      if (imageCount > 0) {
        const replacement = `[${imageCount} image(s) stripped]`;
        operations.push({ ...base, operation: "image_strip", replacementSummary: replacement });
        return withReplacedContent(message, stripImageBlocks(toolResult.content, imageCount));
      }
    }

    return message;
  });

  const tokensSaved =
    operations.length === 0
      ? 0
      : Math.max(
          0,
          estimateBrewvaCompactionTokens(messages) - estimateBrewvaCompactionTokens(prunedMessages),
        );

  return { messages: prunedMessages, operations, tokensSaved };
}
