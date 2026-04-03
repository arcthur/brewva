import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { attachBrewvaToolExecutionTraits } from "@brewva/brewva-tools";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
  createHostedToolExecutionCoordinator,
  wrapToolDefinitionWithHostedExecutionTraits,
} from "../../../packages/brewva-gateway/src/tool-execution-traits.js";

const requireFromBrewvaTools = createRequire(
  new URL("../../../packages/brewva-tools/package.json", import.meta.url),
);

type SchemaLike = Record<string, unknown>;
type TypeBoxFactory = {
  Object: (properties: Record<string, SchemaLike>) => SchemaLike;
  String: (...args: unknown[]) => SchemaLike;
};

interface ExecutionProbeInput {
  mode: string;
}

const { Type } = requireFromBrewvaTools("@sinclair/typebox") as {
  Type: TypeBoxFactory;
};

function createExtensionContext(sessionId: string): ExtensionContext {
  return {
    ui: {} as ExtensionContext["ui"],
    hasUI: false,
    cwd: "/tmp/brewva-tool-execution",
    sessionManager: {
      getSessionId: () => sessionId,
    } as ExtensionContext["sessionManager"],
    modelRegistry: {
      getAll() {
        return [];
      },
    } as unknown as ExtensionContext["modelRegistry"],
    model: undefined,
    isIdle() {
      return true;
    },
    abort() {
      return undefined;
    },
    hasPendingMessages() {
      return false;
    },
    shutdown() {
      return undefined;
    },
    getContextUsage() {
      return undefined;
    },
    compact() {
      return undefined;
    },
    getSystemPrompt() {
      return "";
    },
  };
}

function createDeferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return {
    promise,
    resolve: () => resolve?.(),
  };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("condition_not_met_before_timeout");
    }
    await Promise.resolve();
  }
}

describe("hosted tool execution traits", () => {
  test("serializes concurrency-unsafe executions behind shared read-safe work", async () => {
    const coordinator = createHostedToolExecutionCoordinator();
    const startOrder: string[] = [];
    const read1 = createDeferred();
    const read2 = createDeferred();
    const write = createDeferred();

    const baseTool: ToolDefinition = {
      name: "execution_traits_probe",
      label: "probe",
      description: "probe tool",
      parameters: Type.Object({
        mode: Type.String(),
      }) as ToolDefinition["parameters"],
      async execute(_toolCallId, params) {
        const input = params as ExecutionProbeInput;
        startOrder.push(`start:${input.mode}`);
        if (input.mode === "read1") {
          await read1.promise;
        } else if (input.mode === "read2") {
          await read2.promise;
        } else {
          await write.promise;
        }
        startOrder.push(`end:${input.mode}`);
        return {
          content: [],
          details: {},
        };
      },
    };
    const tool = attachBrewvaToolExecutionTraits(baseTool, ({ args }) => ({
      concurrencySafe:
        typeof (args as ExecutionProbeInput | undefined)?.mode === "string" &&
        (args as ExecutionProbeInput).mode.startsWith("read"),
      interruptBehavior: "cancel",
      streamingEligible: false,
      contextModifying: false,
    }));

    const wrapped = wrapToolDefinitionWithHostedExecutionTraits(tool, coordinator);
    const ctx = createExtensionContext("tool-execution-shared-exclusive");

    const readPromise1 = wrapped.execute("tc-read-1", { mode: "read1" }, undefined, undefined, ctx);
    const readPromise2 = wrapped.execute("tc-read-2", { mode: "read2" }, undefined, undefined, ctx);
    await Promise.resolve();

    const writePromise = wrapped.execute("tc-write", { mode: "write" }, undefined, undefined, ctx);
    await Promise.resolve();

    expect(startOrder).toEqual(["start:read1", "start:read2"]);

    read1.resolve();
    await Promise.resolve();
    expect(startOrder).toEqual(["start:read1", "start:read2", "end:read1"]);

    read2.resolve();
    await Promise.resolve();
    expect(startOrder).toEqual(["start:read1", "start:read2", "end:read1", "end:read2"]);

    await waitForCondition(() => startOrder.includes("start:write"));
    expect(startOrder).toEqual([
      "start:read1",
      "start:read2",
      "end:read1",
      "end:read2",
      "start:write",
    ]);

    write.resolve();
    await Promise.all([readPromise1, readPromise2, writePromise]);
    expect(startOrder.at(-1)).toBe("end:write");
  });

  test("honors cancel-vs-block interrupt behavior while waiting for the session lock", async () => {
    const coordinator = createHostedToolExecutionCoordinator();
    const started: string[] = [];
    const firstGate = createDeferred();

    const baseTool: ToolDefinition = {
      name: "execution_traits_interrupt_probe",
      label: "probe",
      description: "interrupt probe",
      parameters: Type.Object({
        mode: Type.String(),
      }) as ToolDefinition["parameters"],
      async execute(_toolCallId, params, signal) {
        const input = params as ExecutionProbeInput;
        started.push(input.mode);
        if (input.mode === "hold") {
          await firstGate.promise;
        }
        return {
          content: signal?.aborted === true ? [{ type: "text", text: "aborted" }] : [],
          details: {},
        };
      },
    };
    const tool = attachBrewvaToolExecutionTraits(baseTool, ({ args }) => {
      const mode =
        args && typeof args === "object" && typeof (args as { mode?: unknown }).mode === "string"
          ? (args as { mode: string }).mode
          : "";
      return {
        concurrencySafe: false,
        interruptBehavior: mode === "cancel_waiting" ? "cancel" : "block",
        streamingEligible: false,
        contextModifying: true,
      };
    });

    const wrapped = wrapToolDefinitionWithHostedExecutionTraits(tool, coordinator);
    const ctx = createExtensionContext("tool-execution-interrupts");

    const holding = wrapped.execute("tc-hold", { mode: "hold" }, undefined, undefined, ctx);
    await Promise.resolve();

    const cancelController = new AbortController();
    const cancelWaiting = wrapped.execute(
      "tc-cancel",
      { mode: "cancel_waiting" },
      cancelController.signal,
      undefined,
      ctx,
    );
    cancelController.abort();
    let cancelError: unknown;
    try {
      await cancelWaiting;
    } catch (error) {
      cancelError = error;
    }
    expect(cancelError).toBeInstanceOf(Error);
    expect((cancelError as Error).message).toBe("tool_execution_aborted_before_start");

    const blockController = new AbortController();
    const blockWaiting = wrapped.execute(
      "tc-block",
      { mode: "block_waiting" },
      blockController.signal,
      undefined,
      ctx,
    );
    blockController.abort();

    firstGate.resolve();
    await holding;
    await blockWaiting;

    expect(started).toEqual(["hold", "block_waiting"]);
  });
});
