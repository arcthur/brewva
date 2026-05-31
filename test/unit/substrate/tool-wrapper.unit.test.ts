import { describe, expect, test } from "bun:test";
import { defineBrewvaTool, wrapBrewvaTool } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import { toolOutcomePayload } from "../../helpers/tool-outcome.js";

describe("wrapBrewvaTool", () => {
  test("runs hooks around the wrapped tool while preserving metadata descriptors", async () => {
    const calls: string[] = [];
    const baseTool = defineBrewvaTool({
      name: "wrapped",
      label: "Wrapped",
      description: "Wrapped tool",
      parameters: Type.Object({ value: Type.String() }),
      async execute(_toolCallId, params) {
        calls.push(`execute:${params.value}`);
        return {
          content: [{ type: "text", text: "ok" }],
          outcome: { kind: "ok", value: { value: params.value } },
        };
      },
    });
    Object.defineProperty(baseTool, "brewvaExecutionTraits", {
      enumerable: false,
      value: { concurrencySafe: true },
    });

    const wrapped = wrapBrewvaTool(baseTool, {
      before(input) {
        calls.push(`before:${(input.params as { value: string }).value}`);
      },
      after(input) {
        calls.push(`after:${(toolOutcomePayload(input.result) as { value: string }).value}`);
      },
    });

    const result = await wrapped.execute("call-1", { value: "alpha" }, undefined, undefined, {
      cwd: "/tmp",
    } as never);

    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(calls).toEqual(["before:alpha", "execute:alpha", "after:alpha"]);
    expect(Object.getOwnPropertyDescriptor(wrapped, "brewvaExecutionTraits")).toMatchObject({
      enumerable: false,
      value: { concurrencySafe: true },
    });
  });

  test("lets onError return a tool result fallback", async () => {
    const wrapped = wrapBrewvaTool(
      defineBrewvaTool({
        name: "failing",
        label: "Failing",
        description: "Failing tool",
        parameters: Type.Object({}),
        async execute() {
          throw new Error("boom");
        },
      }),
      {
        onError(input) {
          return {
            content: [
              {
                type: "text",
                text: input.error instanceof Error ? input.error.message : "failed",
              },
            ],
            outcome: {
              kind: "err",
              error: {
                message: input.error instanceof Error ? input.error.message : "failed",
              },
            },
          };
        },
      },
    );

    const result = await wrapped.execute("call-2", {}, undefined, undefined, {
      cwd: "/tmp",
    } as never);
    expect(result).toMatchObject({
      content: [{ type: "text", text: "boom" }],
      outcome: { kind: "err" },
    });
  });
});
