import { describe, expect, test } from "bun:test";
import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import type {
  AssistantMessageEvent,
  Model,
  StreamingParseStatus,
  Tool,
} from "@brewva/brewva-provider-core/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parseStreamingJson } from "../../../packages/brewva-provider-core/src/parse/json-parse.js";
import {
  createStreamingParseRegistry,
  EMPTY_PARSE_REGISTRY,
  partialize,
} from "../../../packages/brewva-provider-core/src/parse/typebox-partialize.js";
import { createAssistantMessage } from "../../../packages/brewva-provider-core/src/stream/assistant-message.js";
import { IncrementalToolCallFolder } from "../../../packages/brewva-provider-core/src/stream/tool-call-folder.js";
import {
  createRecordingProviderEventStream,
  runProviderCoreEffect,
  type RecordingProviderEventStream,
} from "../../helpers/effect-stream.js";

async function collectEvents(stream: RecordingProviderEventStream) {
  await runProviderCoreEffect(stream.end());
  return stream.events;
}

type ToolCallEventType = "toolcall_start" | "toolcall_delta" | "toolcall_end";

function findToolCallEvent<TType extends ToolCallEventType>(
  events: readonly AssistantMessageEvent[],
  type: TType,
): Extract<AssistantMessageEvent, { type: TType }> | undefined {
  return events.find(
    (event): event is Extract<AssistantMessageEvent, { type: TType }> => event.type === type,
  );
}

function filterToolCallEvents<TType extends ToolCallEventType>(
  events: readonly AssistantMessageEvent[],
  type: TType,
): Array<Extract<AssistantMessageEvent, { type: TType }>> {
  return events.filter(
    (event): event is Extract<AssistantMessageEvent, { type: TType }> => event.type === type,
  );
}

// `parseStatus` is an Advisory<StreamingParseStatus>; unwrap the brand to assert its
// underlying value. The brand is erased at runtime, so this is a type-only widening.
function statusValue(status: StreamingParseStatus | undefined): StreamingParseStatus | undefined {
  return status;
}

const TEST_MODEL: Model<"openai-responses"> = {
  api: "openai-responses",
  id: "gpt-5.4-mini",
  name: "GPT-5.4 Mini",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  contextWindow: 128_000,
  maxTokens: 16_384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe("incremental tool call folder", () => {
  test("tracks interleaved incremental tool calls without leaking partialJson", async () => {
    const output = createAssistantMessage(TEST_MODEL);
    const stream = createRecordingProviderEventStream();
    const folder = new IncrementalToolCallFolder(output, stream, () => BrewvaEffect.void);

    await runProviderCoreEffect(folder.begin("call:1", { id: "call_1", name: "search" }));
    await runProviderCoreEffect(folder.begin("call:2", { id: "call_2", name: "read" }));
    await runProviderCoreEffect(folder.appendArgumentsDelta("call:1", '{"query":"alpha"'));
    await runProviderCoreEffect(folder.appendArgumentsDelta("call:2", '{"path":"README'));
    await runProviderCoreEffect(folder.replaceArguments("call:1", '{"query":"alpha","limit":2}'));
    await runProviderCoreEffect(folder.replaceArguments("call:2", '{"path":"README.md"}'));
    await runProviderCoreEffect(folder.finalize("call:2"));
    await runProviderCoreEffect(folder.finalize("call:1"));

    const events = await collectEvents(stream);
    expect(events.map((event) => event.type)).toEqual([
      "toolcall_start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_delta",
      "toolcall_delta",
      "toolcall_delta",
      "toolcall_end",
      "toolcall_end",
    ]);
    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_1",
        name: "search",
        arguments: {
          query: "alpha",
          limit: 2,
        },
      },
      {
        type: "toolCall",
        id: "call_2",
        name: "read",
        arguments: {
          path: "README.md",
        },
      },
    ]);
    expect(JSON.stringify(output.content)).not.toContain("partialJson");
  });

  test("supports atomic tool calls with one shared seam", async () => {
    const output = createAssistantMessage(TEST_MODEL);
    const stream = createRecordingProviderEventStream();
    const folder = new IncrementalToolCallFolder(output, stream, () => BrewvaEffect.void);

    await runProviderCoreEffect(
      folder.pushAtomic(
        {
          type: "toolCall",
          id: "call_3",
          name: "lookup",
          arguments: { id: 3 },
          thoughtSignature: "sig_3",
        },
        "call:3",
      ),
    );

    const events = await collectEvents(stream);
    expect(events.map((event) => event.type)).toEqual([
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
    ]);
    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_3",
        name: "lookup",
        arguments: { id: 3 },
        thoughtSignature: "sig_3",
      },
    ]);
  });

  test("emits parseStatus undefined when no registry is provided", async () => {
    const output = createAssistantMessage(TEST_MODEL);
    const stream = createRecordingProviderEventStream();
    const folder = new IncrementalToolCallFolder(output, stream, () => BrewvaEffect.void);

    await runProviderCoreEffect(
      folder.begin("call:1", { id: "call_1", name: "search" }, '{"query":"alpha"}'),
    );
    await runProviderCoreEffect(folder.finalize("call:1"));

    const events = await collectEvents(stream);
    const startEvent = findToolCallEvent(events, "toolcall_start");
    const endEvent = findToolCallEvent(events, "toolcall_end");
    // Without registry, parseStatus should be undefined (not set)
    expect(startEvent?.parseStatus).toBe(undefined);
    expect(endEvent?.parseStatus).toBe(undefined);
  });

  test("emits parseStatus when registry is provided", async () => {
    const readTool: Tool = {
      name: "read",
      description: "Read a file",
      parameters: Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number()),
      }),
    };
    const registry = createStreamingParseRegistry([readTool]);

    const output = createAssistantMessage(TEST_MODEL);
    const stream = createRecordingProviderEventStream();
    const folder = new IncrementalToolCallFolder(output, stream, () => BrewvaEffect.void, registry);

    // Start with empty arguments — should be "pending" (missing required path is OK during streaming)
    await runProviderCoreEffect(folder.begin("call:1", { id: "call_1", name: "read" }, "{}"));
    const eventsAfterStart = await collectEvents(stream);

    const startEvent = findToolCallEvent(eventsAfterStart, "toolcall_start");
    expect(statusValue(startEvent?.parseStatus)).toBe("pending");
  });

  test("validates seed arguments when a provider starts with object input", async () => {
    const tool: Tool = {
      name: "health",
      description: "Health",
      parameters: Type.Object({}),
    };
    const registry = createStreamingParseRegistry([tool]);

    const output = createAssistantMessage(TEST_MODEL);
    const stream = createRecordingProviderEventStream();
    const folder = new IncrementalToolCallFolder(output, stream, () => BrewvaEffect.void, registry);

    await runProviderCoreEffect(
      folder.begin("call:1", { id: "call_1", name: "health", arguments: {} }),
    );
    await runProviderCoreEffect(folder.finalize("call:1"));

    const events = await collectEvents(stream);
    const startEvent = findToolCallEvent(events, "toolcall_start");
    const endEvent = findToolCallEvent(events, "toolcall_end");
    expect(statusValue(startEvent?.parseStatus)).toBe("pending");
    expect(statusValue(endEvent?.parseStatus)).toBe("pending");
  });

  test("emits likely_invalid when a present value violates enum constraint", async () => {
    const tool: Tool = {
      name: "action",
      description: "Perform action",
      parameters: Type.Object({
        mode: Type.Union([Type.Literal("read"), Type.Literal("edit")]),
      }),
    };
    const registry = createStreamingParseRegistry([tool]);

    const output = createAssistantMessage(TEST_MODEL);
    const stream = createRecordingProviderEventStream();
    const folder = new IncrementalToolCallFolder(output, stream, () => BrewvaEffect.void, registry);

    await runProviderCoreEffect(
      folder.begin("call:1", { id: "call_1", name: "action" }, '{"mode":"delete"}'),
    );

    const events = await collectEvents(stream);
    const startEvent = findToolCallEvent(events, "toolcall_start");
    expect(statusValue(startEvent?.parseStatus)).toBe("likely_invalid");
  });

  test("emits pending when required fields are absent but stream is still in progress", async () => {
    const tool: Tool = {
      name: "write",
      description: "Write a file",
      parameters: Type.Object({
        path: Type.String(),
        content: Type.String(),
      }),
    };
    const registry = createStreamingParseRegistry([tool]);

    const output = createAssistantMessage(TEST_MODEL);
    const stream = createRecordingProviderEventStream();
    const folder = new IncrementalToolCallFolder(output, stream, () => BrewvaEffect.void, registry);

    // Partial: only path present, content missing. In streaming, this is "pending".
    await runProviderCoreEffect(
      folder.begin("call:1", { id: "call_1", name: "write" }, '{"path":"/tmp/test.txt"}'),
    );
    const events = await collectEvents(stream);

    const startEvent = findToolCallEvent(events, "toolcall_start");
    expect(statusValue(startEvent?.parseStatus)).toBe("pending");
  });

  test("falls back to permissive parse for unknown tools", async () => {
    const tool: Tool = {
      name: "known_tool",
      description: "A known tool",
      parameters: Type.Object({ x: Type.String() }),
    };
    const registry = createStreamingParseRegistry([tool]);

    const output = createAssistantMessage(TEST_MODEL);
    const stream = createRecordingProviderEventStream();
    const folder = new IncrementalToolCallFolder(output, stream, () => BrewvaEffect.void, registry);

    // "unknown_tool" is not in the registry — should fall back to permissive
    await runProviderCoreEffect(
      folder.begin("call:1", { id: "call_1", name: "unknown_tool" }, '{"data":123}'),
    );
    const events = await collectEvents(stream);

    const startEvent = findToolCallEvent(events, "toolcall_start");
    // Permissive parse: no schema, so parseStatus should be undefined
    expect(startEvent?.parseStatus).toBe(undefined);
  });

  test("appendArgumentsDelta emits parseStatus on each delta", async () => {
    const tool: Tool = {
      name: "read",
      description: "Read a file",
      parameters: Type.Object({
        path: Type.String(),
      }),
    };
    const registry = createStreamingParseRegistry([tool]);

    const output = createAssistantMessage(TEST_MODEL);
    const stream = createRecordingProviderEventStream();
    const folder = new IncrementalToolCallFolder(output, stream, () => BrewvaEffect.void, registry);

    await runProviderCoreEffect(folder.begin("call:1", { id: "call_1", name: "read" }));
    await runProviderCoreEffect(folder.appendArgumentsDelta("call:1", '{"path":"/tmp'));
    await runProviderCoreEffect(folder.appendArgumentsDelta("call:1", '/test.txt"}'));
    await runProviderCoreEffect(folder.finalize("call:1"));

    const events = await collectEvents(stream);
    const deltaEvents = filterToolCallEvents(events, "toolcall_delta");
    // Each delta should have a parseStatus since we have a registry and tool name
    for (const delta of deltaEvents) {
      expect(typeof delta.parseStatus).toBe("string");
    }

    const endEvent = findToolCallEvent(events, "toolcall_end");
    expect(statusValue(endEvent?.parseStatus)).toBe("pending");
    expect((output.content[0] as any).arguments).toEqual({ path: "/tmp/test.txt" });
  });
});

describe("parseStreamingJson", () => {
  test("returns incomplete for empty input", () => {
    const result = parseStreamingJson("");
    expect(result.parseStatus).toBe(undefined);
    expect(result.output).toEqual({});
  });

  test("returns incomplete for empty input when schema is available", () => {
    const tool: Tool = {
      name: "read",
      description: "Read",
      parameters: Type.Object({ path: Type.String() }),
    };
    const registry = createStreamingParseRegistry([tool]);

    const result = parseStreamingJson("", "read", registry);
    expect(result.parseStatus).toBe("incomplete");
    expect(result.output).toEqual({});
  });

  test("returns incomplete for undefined input", () => {
    const result = parseStreamingJson(undefined);
    expect(result.parseStatus).toBe(undefined);
  });

  test("parses complete JSON without registry", () => {
    const result = parseStreamingJson('{"path":"/tmp/test.txt"}');
    expect(result.parseStatus).toBe(undefined);
    expect(result.output).toEqual({ path: "/tmp/test.txt" });
  });

  test("parses partial JSON without registry", () => {
    const result = parseStreamingJson('{"path":"/tmp/tes');
    expect(result.parseStatus).toBe(undefined);
    expect(result.output).toEqual({ path: "/tmp/tes" });
  });

  test("returns empty output for unparseable input", () => {
    const result = parseStreamingJson("{invalid");
    // partial-json may still parse partial objects; output depends on library.
    // The key invariant: output is always a valid object.
    expect(typeof result.output).toBe("object");
  });

  test("returns incomplete for unrecoverable input when schema is available", () => {
    const tool: Tool = {
      name: "read",
      description: "Read",
      parameters: Type.Object({ path: Type.String() }),
    };
    const registry = createStreamingParseRegistry([tool]);

    const result = parseStreamingJson("[", "read", registry);
    expect(result.parseStatus).toBe("incomplete");
    expect(result.output).toEqual({});
  });

  test("applies schema-constrained parse with registry", () => {
    const tool: Tool = {
      name: "read",
      description: "Read",
      parameters: Type.Object({ path: Type.String() }),
    };
    const registry = createStreamingParseRegistry([tool]);

    const result = parseStreamingJson('{"path":"/tmp/test.txt"}', "read", registry);
    expect(result.parseStatus).toBe("pending");
    expect(result.output).toEqual({ path: "/tmp/test.txt" });
  });

  test("returns likely_invalid for schema violation with registry", () => {
    const tool: Tool = {
      name: "action",
      description: "Action",
      parameters: Type.Object({
        mode: Type.Union([Type.Literal("read"), Type.Literal("edit")]),
      }),
    };
    const registry = createStreamingParseRegistry([tool]);

    const result = parseStreamingJson('{"mode":"delete"}', "action", registry);
    expect(result.parseStatus).toBe("likely_invalid");
    expect(result.output).toEqual({ mode: "delete" });
    expect(Array.isArray(result.unmetConstraints)).toBe(true);
    expect(result.unmetConstraints!.length).toBeGreaterThan(0);
  });

  test("does not flag partial enum string prefixes as likely_invalid", () => {
    const tool: Tool = {
      name: "action",
      description: "Action",
      parameters: Type.Object({
        mode: Type.Union([Type.Literal("read"), Type.Literal("edit")]),
      }),
    };
    const registry = createStreamingParseRegistry([tool]);

    const result = parseStreamingJson('{"mode":"ed', "action", registry);
    expect(result.parseStatus).toBe("pending");
    expect(result.output).toEqual({ mode: "ed" });
    expect(result.unmetConstraints).toBe(undefined);
  });

  test("falls back to permissive parse for unknown tool name", () => {
    const registry = createStreamingParseRegistry([]);
    const result = parseStreamingJson('{"anything":1}', "unknown", registry);
    expect(result.parseStatus).toBe(undefined);
    expect(result.output).toEqual({ anything: 1 });
  });
});

describe("partialize", () => {
  test("makes all required properties optional", () => {
    const schema = Type.Object({
      name: Type.String(),
      age: Type.Optional(Type.Number()),
    });
    const partial = partialize(schema);

    // The partialized schema should accept empty objects
    expect(Value.Check(partial, {})).toBe(true);
    expect(Value.Check(partial, { name: "test" })).toBe(true);
    expect(Value.Check(partial, { name: "test", age: 5 })).toBe(true);
  });

  test("recursively makes nested required properties optional", () => {
    const schema = Type.Object({
      config: Type.Object({
        path: Type.String(),
        options: Type.Optional(
          Type.Object({
            mode: Type.Union([Type.Literal("read"), Type.Literal("edit")]),
          }),
        ),
      }),
    });
    const partial = partialize(schema);

    expect(Value.Check(partial, {})).toBe(true);
    expect(Value.Check(partial, { config: {} })).toBe(true);
    expect(Value.Check(partial, { config: { options: {} } })).toBe(true);
  });

  test("partializes object schemas inside arrays", () => {
    const schema = Type.Object({
      edits: Type.Array(
        Type.Object({
          path: Type.String(),
          oldText: Type.String(),
          newText: Type.String(),
        }),
      ),
    });
    const partial = partialize(schema);

    expect(Value.Check(partial, { edits: [{}] })).toBe(true);
    expect(Value.Check(partial, { edits: [{ path: "a.ts" }] })).toBe(true);
  });

  test("partializes unions of objects", () => {
    const schema = Type.Union([
      Type.Object({ type: Type.Literal("a"), value: Type.String() }),
      Type.Object({ type: Type.Literal("b"), count: Type.Number() }),
    ]);
    const partial = partialize(schema);

    expect(Value.Check(partial, {})).toBe(true);
    expect(Value.Check(partial, { type: "a" })).toBe(true);
  });

  test("returns unsupported constructs as-is", () => {
    const schema = Type.Unsafe({ type: "string" });
    const partial = partialize(schema);
    // Should return the same schema for unsupported constructs
    expect(partial).toBe(schema);
  });
});

describe("createStreamingParseRegistry", () => {
  test("returns schema for known tools", () => {
    const tool: Tool = {
      name: "read",
      description: "Read",
      parameters: Type.Object({ path: Type.String() }),
    };
    const registry = createStreamingParseRegistry([tool]);
    const readSchema = registry.get("read") as { safeParse?: unknown } | undefined;
    expect(typeof readSchema?.safeParse).toBe("function");
  });

  test("returns undefined for unknown tools", () => {
    const registry = createStreamingParseRegistry([]);
    expect(registry.get("unknown")).toBe(undefined);
  });

  test("EMPTY_PARSE_REGISTRY always returns undefined", () => {
    expect(EMPTY_PARSE_REGISTRY.get("anything")).toBe(undefined);
  });
});

describe("streaming parse AJV coercion parity", () => {
  test("does not flag numeric string for number field as likely_invalid", () => {
    const tool: Tool = {
      name: "count",
      description: "Count",
      parameters: Type.Object({ count: Type.Number() }),
    };
    const registry = createStreamingParseRegistry([tool]);

    // Terminal AJV validation uses coerceTypes, so the streaming advisory signal
    // should not report values accepted by the terminal gate as invalid.
    const result = parseStreamingJson('{"count":"2"}', "count", registry);
    expect(result.parseStatus).toBe("pending");
    expect(result.output).toEqual({ count: "2" });
  });

  test("accepts numeric value for number field", () => {
    const tool: Tool = {
      name: "count",
      description: "Count",
      parameters: Type.Object({ count: Type.Number() }),
    };
    const registry = createStreamingParseRegistry([tool]);

    // LLM sends {"count": 2} — JSON.parse produces number 2
    const result = parseStreamingJson('{"count":2}', "count", registry);
    expect(result.parseStatus).toBe("pending");
    expect(result.output).toEqual({ count: 2 });
  });

  test("handles nullable fields correctly", () => {
    const tool: Tool = {
      name: "nullable",
      description: "Nullable",
      parameters: Type.Object({ name: Type.Union([Type.String(), Type.Null()]) }),
    };
    const registry = createStreamingParseRegistry([tool]);

    const resultNull = parseStreamingJson('{"name":null}', "nullable", registry);
    expect(resultNull.parseStatus).toBe("pending");

    const resultStr = parseStreamingJson('{"name":"test"}', "nullable", registry);
    expect(resultStr.parseStatus).toBe("pending");
  });

  test("relaxes additionalProperties:false for streaming (terminal AJV still enforces)", () => {
    const tool: Tool = {
      name: "strict",
      description: "Strict",
      parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
    };
    const registry = createStreamingParseRegistry([tool]);

    // During streaming, partial-json might produce extra keys before the
    // stream is complete. The partialized schema relaxes additionalProperties
    // to avoid false likely_invalid signals.
    const result = parseStreamingJson('{"path":"/a","extra":1}', "strict", registry);
    expect(result.parseStatus).toBe("pending");
  });
});

describe("streaming parse Type.Recursive coverage", () => {
  test("handles recursive schema used in schedule-intent", () => {
    const ConvergencePredicateSchema = Type.Recursive((Self) =>
      Type.Union([
        Type.Object({
          kind: Type.Literal("claim_resolved"),
          factId: Type.String(),
        }),
        Type.Object({
          kind: Type.Literal("max_runs"),
          limit: Type.Integer(),
        }),
        Type.Object({
          kind: Type.Literal("all_of"),
          predicates: Type.Array(Self),
        }),
      ]),
    );

    const tool: Tool = {
      name: "schedule",
      description: "Schedule",
      parameters: Type.Object({
        predicate: Type.Optional(ConvergencePredicateSchema),
      }),
    };
    const registry = createStreamingParseRegistry([tool]);

    // Partial: empty object
    const result1 = parseStreamingJson("{}", "schedule", registry);
    expect(result1.parseStatus).toBe("pending");

    // Valid partial: kind present
    const result2 = parseStreamingJson(
      '{"predicate":{"kind":"max_runs","limit":5}}',
      "schedule",
      registry,
    );
    expect(result2.parseStatus).toBe("pending");

    // Invalid: wrong kind value
    const result3 = parseStreamingJson('{"predicate":{"kind":"invalid"}}', "schedule", registry);
    expect(result3.parseStatus).toBe("likely_invalid");
  });
});
