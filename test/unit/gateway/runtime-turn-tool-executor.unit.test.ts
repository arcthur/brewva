import { describe, expect, test } from "bun:test";
import { defineBrewvaTool } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import { createHostedRuntimeToolExecutorPort } from "../../../packages/brewva-gateway/src/hosted/internal/turn/runtime-turn-tool-executor.js";

function createExecutorSession(tool: ReturnType<typeof defineBrewvaTool>) {
  return {
    getRegisteredTools() {
      return [tool];
    },
    createRuntimeToolContext() {
      return {};
    },
  } as never;
}

describe("runtime turn tool executor", () => {
  test("fails closed when a tool outcome does not match its output schema", async () => {
    const tool = defineBrewvaTool({
      name: "schema_probe",
      label: "Schema Probe",
      description: "Returns a schema-validated payload.",
      parameters: Type.Object({}),
      outputSchema: Type.Object(
        {
          answer: Type.String(),
        },
        { additionalProperties: false },
      ),
      errorSchema: Type.Object(
        {
          message: Type.String(),
        },
        { additionalProperties: false },
      ),
      outcomeVersion: "v1",
      async execute() {
        return {
          content: [{ type: "text", text: "bad payload" }],
          outcome: { kind: "ok", value: { answer: 42 } },
        };
      },
    });

    const executor = createHostedRuntimeToolExecutorPort(createExecutorSession(tool));

    try {
      await executor.execute(
        {
          id: "commitment-schema-probe",
          call: {
            sessionId: "s1",
            toolCallId: "call-schema-probe",
            toolName: "schema_probe",
            args: {},
          },
        },
        {},
      );
      expect.unreachable("expected schema mismatch to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("tool_outcome_schema_mismatch:schema_probe:ok");
    }
  });

  // RFC: Checked Invariants And Disciplined Peer Borrowing — item C.
  // Execution binds the tool identity advertised at proposal (turn start), so a
  // mid-turn surface drift cannot make a tool_call run a different tool.
  test("fails closed when a tool's identity drifts between proposal and execution", async () => {
    const proposed = defineBrewvaTool({
      name: "drift_probe",
      label: "Drift Probe",
      description: "A tool whose parameters schema drifts mid-turn.",
      parameters: Type.Object({ value: Type.String() }),
      async execute() {
        return { content: [{ type: "text", text: "ran" }], outcome: { kind: "ok", value: {} } };
      },
    });
    const drifted = defineBrewvaTool({
      name: "drift_probe",
      label: "Drift Probe",
      description: "A tool whose parameters schema drifts mid-turn.",
      parameters: Type.Object({ value: Type.Number() }),
      async execute() {
        return { content: [{ type: "text", text: "ran" }], outcome: { kind: "ok", value: {} } };
      },
    });
    let current: unknown = proposed;
    const session = {
      getRegisteredTools() {
        return [current];
      },
      createRuntimeToolContext() {
        return {};
      },
    } as never;
    const executor = createHostedRuntimeToolExecutorPort(session);
    current = drifted;

    try {
      await executor.execute(
        {
          id: "commitment-drift",
          call: { sessionId: "s1", toolCallId: "call-drift", toolName: "drift_probe", args: {} },
        },
        {},
      );
      expect.unreachable("expected identity drift to fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("tool_identity_drift:drift_probe");
    }
  });

  test("passes through inconclusive outcomes without mapping them to tool errors", async () => {
    const tool = defineBrewvaTool({
      name: "inconclusive_probe",
      label: "Inconclusive Probe",
      description: "Returns a partial result.",
      parameters: Type.Object({}),
      outputSchema: Type.Object(
        {
          reason: Type.String(),
        },
        { additionalProperties: false },
      ),
      errorSchema: Type.Object(
        {
          message: Type.String(),
        },
        { additionalProperties: false },
      ),
      outcomeVersion: "v1",
      async execute() {
        return {
          content: [{ type: "text", text: "partial" }],
          outcome: { kind: "inconclusive", value: { reason: "partial" } },
        };
      },
    });

    const executor = createHostedRuntimeToolExecutorPort(createExecutorSession(tool));
    const result = await executor.execute(
      {
        id: "commitment-inconclusive-probe",
        call: {
          sessionId: "s1",
          toolCallId: "call-inconclusive-probe",
          toolName: "inconclusive_probe",
          args: {},
        },
      },
      {},
    );

    expect(result).toMatchObject({
      outcome: { kind: "inconclusive", value: { reason: "partial" } },
      content: [{ type: "text", text: "partial" }],
      metadata: { outcomeVersion: "v1" },
    });
  });

  test("fails closed when a progress outcome does not match its output schema", async () => {
    const tool = defineBrewvaTool({
      name: "progress_schema_probe",
      label: "Progress Schema Probe",
      description: "Emits schema-validated progress.",
      parameters: Type.Object({}),
      outputSchema: Type.Object(
        {
          answer: Type.String(),
        },
        { additionalProperties: false },
      ),
      errorSchema: Type.Object(
        {
          message: Type.String(),
        },
        { additionalProperties: false },
      ),
      outcomeVersion: "v1",
      async execute(_toolCallId, _params, _signal, update) {
        await update?.({
          content: [{ type: "text", text: "bad progress" }],
          outcome: { kind: "ok", value: { answer: 42 } },
        });
        return {
          content: [{ type: "text", text: "done" }],
          outcome: { kind: "ok", value: { answer: "done" } },
        };
      },
    });

    const executor = createHostedRuntimeToolExecutorPort(createExecutorSession(tool));

    try {
      await executor.execute(
        {
          id: "commitment-progress-schema-probe",
          call: {
            sessionId: "s1",
            toolCallId: "call-progress-schema-probe",
            toolName: "progress_schema_probe",
            args: {},
          },
        },
        { onProgress: async () => {} },
      );
      expect.unreachable("expected progress schema mismatch to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "tool_outcome_schema_mismatch:progress_schema_probe:ok",
      );
    }
  });

  test("fails closed when a tool declares an unsupported outcome version", async () => {
    const tool = defineBrewvaTool({
      name: "version_probe",
      label: "Version Probe",
      description: "Returns a result with an unsupported outcome contract version.",
      parameters: Type.Object({}),
      outputSchema: Type.Object({}),
      errorSchema: Type.Object({}),
      outcomeVersion: "v2",
      async execute() {
        return {
          content: [{ type: "text", text: "done" }],
          outcome: { kind: "ok", value: {} },
        };
      },
    });

    const executor = createHostedRuntimeToolExecutorPort(createExecutorSession(tool));

    try {
      await executor.execute(
        {
          id: "commitment-version-probe",
          call: {
            sessionId: "s1",
            toolCallId: "call-version-probe",
            toolName: "version_probe",
            args: {},
          },
        },
        {},
      );
      expect.unreachable("expected unsupported outcome version to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("unsupported_tool_outcome_version:v2");
    }
  });
});
