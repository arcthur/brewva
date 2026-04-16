import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import {
  validateToolArguments,
  validateToolArgumentsResult,
  validateToolCall,
  validateToolCallResult,
} from "../../../packages/brewva-provider-core/src/utils/validation.js";

describe("provider-core validation utils", () => {
  const echoTool = {
    name: "echo",
    description: "Echo text",
    parameters: Type.Object({
      count: Type.Number(),
    }),
  };

  test("returns explicit success with coerced arguments", () => {
    const result = validateToolArgumentsResult(echoTool, {
      type: "toolCall",
      id: "call-1",
      name: "echo",
      arguments: { count: "2" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.args).toMatchObject({ count: 2 });
  });

  test("returns explicit failure for invalid arguments", () => {
    const result = validateToolArgumentsResult(echoTool, {
      type: "toolCall",
      id: "call-1",
      name: "echo",
      arguments: {},
    });

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('Validation failed for tool "echo"'),
    });
  });

  test("returns explicit failure when a tool is missing", () => {
    const result = validateToolCallResult([], {
      type: "toolCall",
      id: "call-1",
      name: "missing",
      arguments: {},
    });

    expect(result).toEqual({
      ok: false,
      error: 'Tool "missing" not found',
    });
  });

  test("preserves throw-based wrappers for callers that still expect exceptions", () => {
    expect(() =>
      validateToolCall([echoTool], {
        type: "toolCall",
        id: "call-1",
        name: "echo",
        arguments: {},
      }),
    ).toThrow('Validation failed for tool "echo"');

    expect(() =>
      validateToolArguments(echoTool, {
        type: "toolCall",
        id: "call-1",
        name: "echo",
        arguments: {},
      }),
    ).toThrow('Validation failed for tool "echo"');
  });
});
