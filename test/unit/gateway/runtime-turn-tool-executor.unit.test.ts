import { describe, expect, test } from "bun:test";
import { defineBrewvaTool } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import { advertisedToolIdentity } from "../../../packages/brewva-gateway/src/hosted/internal/turn/runtime-provider-context.js";
import { createHostedRuntimeToolExecutorPort } from "../../../packages/brewva-gateway/src/hosted/internal/turn/runtime-turn-tool-executor.js";

type DefinedTool = ReturnType<typeof defineBrewvaTool>;

function createExecutorSession(tool: DefinedTool) {
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
  test("verifies the identity persisted on the canonical commitment", async () => {
    const tool = defineBrewvaTool({
      name: "canonical_receipt_probe",
      label: "Canonical Receipt Probe",
      description: "Executes from a canonical proposal receipt.",
      parameters: Type.Object({ value: Type.String() }),
      async execute() {
        return { content: [{ type: "text", text: "ran" }], outcome: { kind: "ok", value: {} } };
      },
    });
    const executor = createHostedRuntimeToolExecutorPort({
      getRegisteredTools() {
        return [tool];
      },
      createRuntimeToolContext() {
        return {};
      },
    } as never);

    const result = await executor.execute(
      {
        id: "commitment-canonical-receipt",
        call: {
          sessionId: "s1",
          toolCallId: "call-canonical-receipt",
          toolName: tool.name,
          args: { value: "x" },
          proposalManifestId: "manifest-canonical",
          proposalToolIdentityHash: advertisedToolIdentity(tool),
        },
      },
      {},
    );

    expect(result.outcome).toEqual({ kind: "ok", value: {} });
  });

  test("fails closed when a referenced proposal omits its canonical tool identity", async () => {
    const tool = defineBrewvaTool({
      name: "missing_canonical_identity_probe",
      label: "Missing Canonical Identity Probe",
      description: "Must not fall back to an advisory receipt resolver.",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "ran" }], outcome: { kind: "ok", value: {} } };
      },
    });
    const executor = createHostedRuntimeToolExecutorPort(createExecutorSession(tool));

    expect(
      executor.execute(
        {
          id: "commitment-missing-canonical-identity",
          call: {
            sessionId: "s1",
            toolCallId: "call-missing-canonical-identity",
            toolName: tool.name,
            args: {},
            proposalManifestId: "manifest-advisory-only",
          },
        },
        {},
      ),
    ).rejects.toThrow("hosted_runtime_tool_not_advertised:missing_canonical_identity_probe");
  });

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
  // Execution binds the tool identity advertised in the proposal receipt the
  // commitment references, so a mid-turn surface drift cannot make a tool_call run
  // a different tool than the one the model was offered.
  test("fails closed when a tool's parameters drift from the advertised receipt", async () => {
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
    const executor = createHostedRuntimeToolExecutorPort(createExecutorSession(drifted));

    try {
      await executor.execute(
        {
          id: "commitment-drift",
          call: {
            sessionId: "s1",
            toolCallId: "call-drift",
            toolName: "drift_probe",
            args: {},
            proposalManifestId: "m1",
            proposalToolIdentityHash: advertisedToolIdentity(proposed),
          },
        },
        {},
      );
      expect.unreachable("expected identity drift to fail closed");
    } catch (error) {
      expect((error as Error).message).toContain("hosted_runtime_tool_identity_drift:drift_probe");
    }
  });

  // The identity includes the description the model saw, which the old
  // parameters-only fingerprint missed.
  test("fails closed when only a tool's description drifts from the receipt", async () => {
    const proposed = defineBrewvaTool({
      name: "desc_probe",
      label: "Desc Probe",
      description: "Original description the model was shown.",
      parameters: Type.Object({ value: Type.String() }),
      async execute() {
        return { content: [{ type: "text", text: "ran" }], outcome: { kind: "ok", value: {} } };
      },
    });
    const reworded = defineBrewvaTool({
      name: "desc_probe",
      label: "Desc Probe",
      description: "A different description swapped in after the model decided.",
      parameters: Type.Object({ value: Type.String() }),
      async execute() {
        return { content: [{ type: "text", text: "ran" }], outcome: { kind: "ok", value: {} } };
      },
    });
    const executor = createHostedRuntimeToolExecutorPort(createExecutorSession(reworded));

    try {
      await executor.execute(
        {
          id: "commitment-desc",
          call: {
            sessionId: "s1",
            toolCallId: "call-desc",
            toolName: "desc_probe",
            args: {},
            proposalManifestId: "m1",
            proposalToolIdentityHash: advertisedToolIdentity(proposed),
          },
        },
        {},
      );
      expect.unreachable("expected a description drift to fail closed");
    } catch (error) {
      expect((error as Error).message).toContain("hosted_runtime_tool_identity_drift:desc_probe");
    }
  });

  // A tool registered after the request was advertised was never offered to the
  // model in that proposal; running it would bypass the gate, so it fails closed.
  test("fails closed when a tool was not advertised in the referenced receipt", async () => {
    const lateTool = defineBrewvaTool({
      name: "late_probe",
      label: "Late Probe",
      description: "Registered after the proposal was advertised.",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "ran" }], outcome: { kind: "ok", value: {} } };
      },
    });
    const executor = createHostedRuntimeToolExecutorPort(createExecutorSession(lateTool));

    try {
      await executor.execute(
        {
          id: "commitment-late",
          call: {
            sessionId: "s1",
            toolCallId: "call-late",
            toolName: "late_probe",
            args: {},
            proposalManifestId: "m1",
          },
        },
        {},
      );
      expect.unreachable("expected an unadvertised tool to fail closed");
    } catch (error) {
      expect((error as Error).message).toContain("hosted_runtime_tool_not_advertised:late_probe");
    }
  });

  // An approval resumed from a persisted request that predates proposal receipts
  // carries neither receipt field; it passes this compatibility gate and still
  // clears ordinary not-found and schema validation.
  test("allows a commitment with no proposal receipt reference", async () => {
    const tool = defineBrewvaTool({
      name: "resumed_probe",
      label: "Resumed Probe",
      description: "Resumed from a persisted approval.",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "ran" }], outcome: { kind: "ok", value: {} } };
      },
    });
    const executor = createHostedRuntimeToolExecutorPort(createExecutorSession(tool));

    const result = await executor.execute(
      {
        id: "commitment-resumed",
        call: { sessionId: "s1", toolCallId: "call-resumed", toolName: "resumed_probe", args: {} },
      },
      {},
    );
    expect(result.outcome).toEqual({ kind: "ok", value: {} });
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

  // A model that hallucinates a near-miss tool name (e.g. task_view_status for the
  // real task_view_state) should get a "did you mean" hint in the not-found error,
  // which is observable on the aborted tool result and lets it self-correct fast.
  test("suggests the closest registered tool name when a tool is not found", async () => {
    const tool = defineBrewvaTool({
      name: "task_view_state",
      label: "Task View State",
      description: "Views the task ledger state.",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "ran" }], outcome: { kind: "ok", value: {} } };
      },
    });
    const executor = createHostedRuntimeToolExecutorPort(createExecutorSession(tool));

    try {
      await executor.execute(
        {
          id: "commitment-not-found",
          call: {
            sessionId: "s1",
            toolCallId: "call-not-found",
            toolName: "task_view_status",
            args: {},
          },
        },
        {},
      );
      expect.unreachable("expected an unknown tool to fail closed");
    } catch (error) {
      expect((error as Error).message).toBe(
        "hosted_runtime_tool_not_found:task_view_status (did you mean task_view_state?)",
      );
    }
  });

  // A wildly different name has no close registered match, so the error stays bare
  // rather than steering the model toward an unrelated tool.
  test("does not suggest a tool name when no registered tool is close", async () => {
    const tool = defineBrewvaTool({
      name: "read",
      label: "Read",
      description: "Reads a file.",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "ran" }], outcome: { kind: "ok", value: {} } };
      },
    });
    const executor = createHostedRuntimeToolExecutorPort(createExecutorSession(tool));

    try {
      await executor.execute(
        {
          id: "commitment-far",
          call: {
            sessionId: "s1",
            toolCallId: "call-far",
            toolName: "subagent_fanout_configure",
            args: {},
          },
        },
        {},
      );
      expect.unreachable("expected an unknown tool to fail closed");
    } catch (error) {
      expect((error as Error).message).toBe(
        "hosted_runtime_tool_not_found:subagent_fanout_configure",
      );
    }
  });
});
