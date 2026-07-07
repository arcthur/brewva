import { describe, expect, test } from "bun:test";
import { pruneCompactionInput } from "@brewva/brewva-substrate/compaction";
import {
  readSessionPreCompactPrunePayload,
  SESSION_PRE_COMPACT_PRUNE_SCHEMA_V1,
  type SessionPreCompactPrunePayload,
} from "@brewva/brewva-vocabulary/session";
import fc from "fast-check";
import { propertyTest } from "../../helpers/property.js";

const LARGE = "x".repeat(400);
const OTHER_LARGE = "y".repeat(400);

const DEFAULT_PROTECTED = new Set([
  "workbench_note",
  "workbench_evict",
  "workbench_undo_evict",
  "workbench_compact",
  "recall_search",
  "recall_curate",
  "tape_handoff",
]);

interface ContentBlock {
  readonly type: string;
  readonly text?: string;
}

function toolResult(toolName: string, text: string, extra: Record<string, unknown> = {}): unknown {
  return { role: "toolResult", toolName, content: [{ type: "text", text }], ...extra };
}

function imageToolResult(toolName: string, text: string, images: number): unknown {
  const content: unknown[] = [{ type: "text", text }];
  for (let i = 0; i < images; i += 1) {
    content.push({ type: "image", data: `img-${i}` });
  }
  return { role: "toolResult", toolName, content };
}

function contentOf(message: unknown): ContentBlock[] {
  return (message as { content: ContentBlock[] }).content;
}

describe("pre-compaction deterministic prune", () => {
  test("dedupes identical old tool-result bodies, keeping the newest occurrence full", () => {
    const messages = [
      toolResult("read", LARGE),
      toolResult("bash", "small unrelated output"),
      toolResult("read", LARGE),
      { role: "user", content: "recent tail" },
    ];
    const result = pruneCompactionInput(messages, {
      tailProtectTokens: 1,
      informReplace: false,
      stripImages: false,
    });
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]?.operation).toBe("dedupe");
    expect(result.operations[0]?.index).toBe(0);
    // The newest occurrence is kept verbatim; only the earlier copy collapses.
    expect(contentOf(result.messages[2])).toEqual([{ type: "text", text: LARGE }]);
    expect(contentOf(result.messages[0])[0]?.text).toContain("duplicate");
  });

  test("inform-replaces an old, substantial text tool result", () => {
    const messages = [toolResult("read", LARGE), { role: "user", content: "recent tail" }];
    const result = pruneCompactionInput(messages, { tailProtectTokens: 1 });
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]?.operation).toBe("inform_replace");
    expect(contentOf(result.messages[0])[0]?.text).toContain("elided by pre-compaction prune");
  });

  test("image-strips an old small-text multimodal result, keeping its text", () => {
    const messages = [
      imageToolResult("read", "short caption", 2),
      { role: "user", content: "tail" },
    ];
    const result = pruneCompactionInput(messages, { tailProtectTokens: 1 });
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]?.operation).toBe("image_strip");
    const content = contentOf(result.messages[0]);
    expect(content.some((block) => block.type === "image")).toBe(false);
    expect(
      content.some((block) => block.type === "text" && block.text?.includes("short caption")),
    ).toBe(true);
  });

  test("inform-replaces (not image-strips) an old large-text multimodal result", () => {
    // Large text takes priority so the pruned state is a stable one-liner; the
    // images ride out with the body. This ordering is what keeps prune idempotent.
    const messages = [imageToolResult("read", LARGE, 2), { role: "user", content: "tail" }];
    const result = pruneCompactionInput(messages, { tailProtectTokens: 1 });
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]?.operation).toBe("inform_replace");
  });

  test("never prunes protected tools, even when old and duplicated", () => {
    const messages = [
      toolResult("workbench_note", LARGE),
      toolResult("workbench_note", LARGE),
      { role: "user", content: "recent tail" },
    ];
    const result = pruneCompactionInput(messages, { tailProtectTokens: 1 });
    expect(result.operations).toHaveLength(0);
  });

  test("honors a caller-supplied protectedTools set", () => {
    const messages = [toolResult("read", LARGE), { role: "user", content: "recent tail" }];
    const result = pruneCompactionInput(messages, {
      tailProtectTokens: 1,
      protectedTools: ["read"],
    });
    expect(result.operations).toHaveLength(0);
  });

  test("protects the recent tail from inform-replace / image-strip", () => {
    const messages = [toolResult("read", LARGE), toolResult("bash", OTHER_LARGE)];
    // A tail window larger than the whole transcript leaves every message recent,
    // so only position-independent dedupe could fire — and there is no duplicate.
    const result = pruneCompactionInput(messages, { tailProtectTokens: 100_000 });
    expect(result.operations).toHaveLength(0);
  });

  test("returns the same message reference for untouched entries", () => {
    const messages = [toolResult("read", LARGE), { role: "user", content: "tail" }];
    const result = pruneCompactionInput(messages, { tailProtectTokens: 1 });
    // The recent user turn is untouched and must be shared by reference, not cloned.
    expect(result.messages[1]).toBe(messages[1]);
  });

  test("does not mutate the input messages", () => {
    const messages = [toolResult("read", LARGE), { role: "user", content: "hi" }];
    const clone = structuredClone(messages);
    pruneCompactionInput(messages, { tailProtectTokens: 1 });
    expect(messages).toEqual(clone);
  });
});

describe("session.pre_compact_prune receipt reader", () => {
  test("parses a well-formed payload and rejects foreign or empty events", () => {
    const payload: SessionPreCompactPrunePayload = {
      schema: SESSION_PRE_COMPACT_PRUNE_SCHEMA_V1,
      sessionId: "session-1",
      compactId: "compact-1",
      operations: [
        {
          index: 0,
          toolName: "read",
          operation: "inform_replace",
          originalDigest: "abc123",
          replacementSummary: "[tool:read] ~120 tokens elided by pre-compaction prune",
        },
      ],
      tokensSaved: 120,
    };
    expect(readSessionPreCompactPrunePayload({ payload })).toEqual(payload);
    expect(
      readSessionPreCompactPrunePayload({ payload: { schema: "brewva.other.v1" } }),
    ).toBeNull();
    expect(readSessionPreCompactPrunePayload({})).toBeNull();
  });
});

const bodyArb = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.constant(LARGE),
  fc.constant(OTHER_LARGE),
  fc.string({ minLength: 220, maxLength: 400 }),
);

const contentArb = fc.array(
  fc.oneof(
    fc.record({ type: fc.constant("text"), text: bodyArb }),
    fc.record({
      type: fc.constantFrom("image", "image_url", "input_image"),
      data: fc.constant("img"),
    }),
  ),
  { maxLength: 3 },
);

const messageArb = fc.oneof(
  fc.record({
    role: fc.constant("toolResult"),
    toolName: fc.constantFrom("read", "bash", "grep", "workbench_note", "recall_search"),
    content: contentArb,
  }),
  fc.record({ role: fc.constantFrom("user", "assistant"), content: fc.string({ maxLength: 60 }) }),
);

const messagesArb = fc.array(messageArb, { maxLength: 10 });
const optsArb = fc.record({ tailProtectTokens: fc.constantFrom(1, 50, 100_000) });

propertyTest("prune is deterministic", {
  propertyId: "substrate.compaction.prune.deterministic",
  layer: "unit",
  arbitraries: [messagesArb, optsArb],
  predicate(messages, opts) {
    const first = pruneCompactionInput(messages, opts);
    const second = pruneCompactionInput(messages, opts);
    expect(second.operations).toEqual(first.operations);
    expect(second.tokensSaved).toBe(first.tokensSaved);
    expect(second.messages).toEqual(first.messages);
  },
});

propertyTest("re-pruning already-pruned output is a no-op", {
  propertyId: "substrate.compaction.prune.idempotent",
  layer: "unit",
  arbitraries: [messagesArb, optsArb],
  predicate(messages, opts) {
    const first = pruneCompactionInput(messages, opts);
    const second = pruneCompactionInput(first.messages, opts);
    expect(second.operations).toHaveLength(0);
    expect(second.messages).toEqual(first.messages);
  },
});

propertyTest("prune never mutates its input", {
  propertyId: "substrate.compaction.prune.pure",
  layer: "unit",
  arbitraries: [messagesArb, optsArb],
  predicate(messages, opts) {
    const clone = structuredClone(messages);
    pruneCompactionInput(messages, opts);
    expect(messages).toEqual(clone);
  },
});

propertyTest("protected tools are never the target of an operation", {
  propertyId: "substrate.compaction.prune.protected-safe",
  layer: "unit",
  arbitraries: [messagesArb, optsArb],
  predicate(messages, opts) {
    const result = pruneCompactionInput(messages, opts);
    for (const op of result.operations) {
      expect(DEFAULT_PROTECTED.has(op.toolName)).toBe(false);
    }
  },
});

propertyTest("operations correspond one-to-one with changed messages and never cost tokens", {
  propertyId: "substrate.compaction.prune.accounting",
  layer: "unit",
  arbitraries: [messagesArb, optsArb],
  predicate(messages, opts) {
    const result = pruneCompactionInput(messages, opts);
    expect(result.tokensSaved).toBeGreaterThanOrEqual(0);
    expect(result.messages).toHaveLength(messages.length);
    let changed = 0;
    for (let index = 0; index < messages.length; index += 1) {
      if (result.messages[index] !== messages[index]) {
        changed += 1;
      }
    }
    expect(changed).toBe(result.operations.length);
  },
});
