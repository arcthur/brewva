import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrewvaRuntime,
  createTrustedLocalGovernancePort,
  type BrewvaEventRecord,
} from "@brewva/brewva-runtime";
import { createOpsRuntimeConfig } from "../../helpers/runtime.js";

function createWorkspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createRuntime(
  options: ConstructorParameters<typeof BrewvaRuntime>[0] = {},
): BrewvaRuntime {
  return new BrewvaRuntime({
    cwd: createWorkspace("brewva-tool-char-"),
    config: createOpsRuntimeConfig(),
    ...options,
  });
}

type EventSummary = {
  type: string;
  payload?: Record<string, unknown>;
};

function summarizeEvents(events: BrewvaEventRecord[]): EventSummary[] {
  return events.map((event) => summarizeEvent(event));
}

function summarizeEvent(event: BrewvaEventRecord): EventSummary {
  switch (event.type) {
    case "tool_effect_gate_selected":
      return {
        type: event.type,
        payload: pick(event.payload, [
          "toolCallId",
          "toolName",
          "boundary",
          "requiresApproval",
          "rollbackable",
        ]),
      };
    case "tool_call_blocked":
      return {
        type: event.type,
        payload: {
          toolName: event.payload?.toolName ?? null,
          reason: normalizeReason(event.payload?.reason),
          decision: event.payload?.decision ?? null,
          requestIdPresent: typeof event.payload?.requestId === "string",
        },
      };
    case "proposal_received":
      return {
        type: event.type,
        payload: pick(event.payload, ["kind", "issuer", "subject", "evidenceCount"]),
      };
    case "proposal_decided":
      return {
        type: event.type,
        payload: {
          kind: event.payload?.kind ?? null,
          decision: event.payload?.decision ?? null,
          reasons: normalizeReasons(event.payload?.reasons),
        },
      };
    case "decision_receipt_recorded":
      return {
        type: event.type,
        payload: {
          decision:
            typeof event.payload?.receipt === "object" &&
            event.payload?.receipt &&
            "decision" in event.payload.receipt
              ? ((event.payload.receipt as { decision?: unknown }).decision ?? null)
              : null,
          committedEffects:
            typeof event.payload?.receipt === "object" &&
            event.payload?.receipt &&
            "committedEffects" in event.payload.receipt &&
            Array.isArray(
              (event.payload.receipt as { committedEffects?: unknown[] }).committedEffects,
            )
              ? (event.payload.receipt as { committedEffects: unknown[] }).committedEffects.length
              : 0,
        },
      };
    case "effect_commitment_approval_requested":
      return {
        type: event.type,
        payload: {
          toolName: event.payload?.toolName ?? null,
          toolCallId: event.payload?.toolCallId ?? null,
          requestIdPresent: typeof event.payload?.requestId === "string",
        },
      };
    case "context_compaction_gate_blocked_tool":
      return {
        type: event.type,
        payload: pick(event.payload, ["blockedTool", "reason"]),
      };
    case "verification_write_marked":
      return {
        type: event.type,
        payload: pick(event.payload, ["toolName"]),
      };
    case "tool_call_marked":
      return {
        type: event.type,
        payload: pick(event.payload, ["toolName", "toolCalls"]),
      };
    case "file_snapshot_captured":
      return {
        type: event.type,
        payload: {
          toolName: event.payload?.toolName ?? null,
          files: Array.isArray(event.payload?.files) ? event.payload.files : [],
        },
      };
    case "reversible_mutation_prepared":
      return {
        type: event.type,
        payload: {
          strategy:
            typeof event.payload?.receipt === "object" &&
            event.payload?.receipt &&
            "strategy" in event.payload.receipt
              ? ((event.payload.receipt as { strategy?: unknown }).strategy ?? null)
              : null,
          rollbackKind:
            typeof event.payload?.receipt === "object" &&
            event.payload?.receipt &&
            "rollbackKind" in event.payload.receipt
              ? ((event.payload.receipt as { rollbackKind?: unknown }).rollbackKind ?? null)
              : null,
        },
      };
    case "tool_result_recorded":
      return {
        type: event.type,
        payload: pick(event.payload, [
          "toolName",
          "toolCallId",
          "verdict",
          "channelSuccess",
          "effectCommitmentRequestId",
          "failureClass",
        ]),
      };
    case "patch_recorded":
      return {
        type: event.type,
        payload: {
          toolName: event.payload?.toolName ?? null,
          toolCallId: event.payload?.toolCallId ?? null,
          patchChangeCount: Array.isArray(event.payload?.changes)
            ? event.payload.changes.length
            : 0,
        },
      };
    case "reversible_mutation_recorded":
      return {
        type: event.type,
        payload: {
          strategy:
            typeof event.payload?.receipt === "object" &&
            event.payload?.receipt &&
            "strategy" in event.payload.receipt
              ? ((event.payload.receipt as { strategy?: unknown }).strategy ?? null)
              : null,
          changed: event.payload?.changed ?? null,
          verdict: event.payload?.verdict ?? null,
          rollbackRefPresent: typeof event.payload?.rollbackRef === "string",
        },
      };
    case "rollback":
      return {
        type: event.type,
        payload: {
          ok: event.payload?.ok ?? null,
          mutationReceiptIdPresent: typeof event.payload?.mutationReceiptId === "string",
          restoredPaths: Array.isArray(event.payload?.restoredPaths)
            ? event.payload.restoredPaths
            : [],
        },
      };
    case "verification_state_reset":
      return {
        type: event.type,
        payload: pick(event.payload, ["reason"]),
      };
    default:
      return {
        type: event.type,
      };
  }
}

function pick(
  payload: Record<string, unknown> | undefined,
  keys: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    out[key] = payload?.[key] ?? null;
  }
  return out;
}

function normalizeReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.startsWith("effect_commitment_pending_operator_approval:")) {
    return "effect_commitment_pending_operator_approval:*";
  }
  if (value.startsWith("effect_commitment_request_args_mismatch:")) {
    return "effect_commitment_request_args_mismatch:*";
  }
  return value;
}

function normalizeReasons(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeReason(entry))
    .filter((entry): entry is string => Boolean(entry));
}

describe("Tool invocation characterization", () => {
  test("shell removal block keeps current gate and block event order", () => {
    const runtime = createRuntime();
    const sessionId = "tool-char-shell";

    const started = runtime.tools.start({
      sessionId,
      toolCallId: "tc-shell",
      toolName: "shell",
      args: { command: "echo hi" },
    });

    expect(started).toMatchObject({
      allowed: false,
      boundary: "effectful",
      reason: "Tool 'shell' has been removed. Use 'exec' with 'process' for command execution.",
    });
    expect(summarizeEvents(runtime.events.query(sessionId))).toEqual([
      {
        type: "tool_effect_gate_selected",
        payload: {
          toolCallId: "tc-shell",
          toolName: "shell",
          boundary: "effectful",
          requiresApproval: true,
          rollbackable: false,
        },
      },
      {
        type: "tool_call_blocked",
        payload: {
          toolName: "shell",
          reason: "Tool 'shell' has been removed. Use 'exec' with 'process' for command execution.",
          decision: null,
          requestIdPresent: false,
        },
      },
    ]);
  });

  test("accepted effect commitment keeps proposal and receipt event order", () => {
    const runtime = createRuntime({
      governancePort: createTrustedLocalGovernancePort(),
    });
    const sessionId = "tool-char-accept";

    const started = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-accept",
      toolName: "exec",
      args: { command: "echo hi" },
    });

    expect(started.allowed).toBe(true);
    expect(started.boundary).toBe("effectful");
    expect(started.commitmentReceipt?.decision).toBe("accept");
    expect(summarizeEvents(runtime.events.query(sessionId))).toEqual([
      {
        type: "tool_effect_gate_selected",
        payload: {
          toolCallId: "tc-exec-accept",
          toolName: "exec",
          boundary: "effectful",
          requiresApproval: true,
          rollbackable: false,
        },
      },
      {
        type: "proposal_received",
        payload: {
          kind: "effect_commitment",
          issuer: "brewva.runtime.tool-gate",
          subject: "tool:exec",
          evidenceCount: 1,
        },
      },
      {
        type: "proposal_decided",
        payload: {
          kind: "effect_commitment",
          decision: "accept",
          reasons: ["effect_commitment_host_authorized:exec"],
        },
      },
      {
        type: "decision_receipt_recorded",
        payload: {
          decision: "accept",
          committedEffects: 1,
        },
      },
      {
        type: "tool_call_marked",
        payload: {
          toolName: "exec",
          toolCalls: 1,
        },
      },
    ]);
  });

  test("deferred effect commitment keeps approval request before block event", () => {
    const runtime = createRuntime();
    const sessionId = "tool-char-defer";

    const started = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-defer",
      toolName: "exec",
      args: { command: "echo hi" },
    });

    expect(started.allowed).toBe(false);
    expect(started.boundary).toBe("effectful");
    expect(started.commitmentReceipt?.decision).toBe("defer");
    expect(typeof started.effectCommitmentRequestId).toBe("string");
    expect(summarizeEvents(runtime.events.query(sessionId))).toEqual([
      {
        type: "tool_effect_gate_selected",
        payload: {
          toolCallId: "tc-exec-defer",
          toolName: "exec",
          boundary: "effectful",
          requiresApproval: true,
          rollbackable: false,
        },
      },
      {
        type: "proposal_received",
        payload: {
          kind: "effect_commitment",
          issuer: "brewva.runtime.tool-gate",
          subject: "tool:exec",
          evidenceCount: 1,
        },
      },
      {
        type: "effect_commitment_approval_requested",
        payload: {
          toolName: "exec",
          toolCallId: "tc-exec-defer",
          requestIdPresent: true,
        },
      },
      {
        type: "proposal_decided",
        payload: {
          kind: "effect_commitment",
          decision: "defer",
          reasons: ["effect_commitment_pending_operator_approval:*"],
        },
      },
      {
        type: "decision_receipt_recorded",
        payload: {
          decision: "defer",
          committedEffects: 0,
        },
      },
      {
        type: "tool_call_blocked",
        payload: {
          toolName: "exec",
          reason: "effect_commitment_pending_operator_approval:*",
          decision: "defer",
          requestIdPresent: true,
        },
      },
    ]);
  });

  test("approved request resume rejects args digest mismatch without mutating state", () => {
    const runtime = createRuntime();
    const sessionId = "tool-char-args-mismatch";
    const sharedPrefix = "x".repeat(320);

    const deferred = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-mismatch",
      toolName: "exec",
      args: { command: `${sharedPrefix}A` },
    });
    const pending = runtime.proposals.listPendingEffectCommitments(sessionId);
    expect(deferred.allowed).toBe(false);
    expect(pending).toHaveLength(1);

    const decision = runtime.proposals.decideEffectCommitment(sessionId, pending[0]!.requestId, {
      decision: "accept",
      actor: "operator:test",
      reason: "exact payload reviewed",
    });
    expect(decision.ok).toBe(true);

    const mismatched = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-mismatch",
      toolName: "exec",
      args: { command: `${sharedPrefix}B` },
      effectCommitmentRequestId: pending[0]!.requestId,
    });

    expect(mismatched).toMatchObject({
      allowed: false,
      boundary: "effectful",
      reason: expect.stringContaining("effect_commitment_request_args_mismatch:"),
      effectCommitmentRequestId: pending[0]!.requestId,
    });
    expect(summarizeEvents(runtime.events.query(sessionId, { last: 3 }))).toEqual([
      {
        type: "effect_commitment_approval_decided",
      },
      {
        type: "tool_effect_gate_selected",
        payload: {
          toolCallId: "tc-exec-mismatch",
          toolName: "exec",
          boundary: "effectful",
          requiresApproval: true,
          rollbackable: false,
        },
      },
      {
        type: "tool_call_blocked",
        payload: {
          toolName: "exec",
          reason: "effect_commitment_request_args_mismatch:*",
          decision: null,
          requestIdPresent: true,
        },
      },
    ]);
  });

  test("compaction gate blocks before commitment flow and preserves unblock path", () => {
    const workspace = createWorkspace("brewva-tool-char-compact-");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: createOpsRuntimeConfig((config) => {
        config.infrastructure.contextBudget.enabled = true;
        config.infrastructure.contextBudget.thresholds.compactionFloorPercent = 0.8;
        config.infrastructure.contextBudget.thresholds.compactionCeilingPercent = 0.8;
        config.infrastructure.contextBudget.thresholds.compactionHeadroomTokens = 24_000;
        config.infrastructure.contextBudget.thresholds.hardLimitFloorPercent = 0.9;
        config.infrastructure.contextBudget.thresholds.hardLimitCeilingPercent = 0.9;
        config.infrastructure.contextBudget.thresholds.hardLimitHeadroomTokens = 8_000;
      }),
      governancePort: createTrustedLocalGovernancePort(),
    });
    const sessionId = "tool-char-compact";
    runtime.context.onTurnStart(sessionId, 3);
    const usage = { tokens: 95, contextWindow: 100, percent: 0.95 };
    runtime.context.observeUsage(sessionId, usage);

    const blocked = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-compact",
      toolName: "exec",
      args: { command: "echo blocked" },
      usage,
    });

    expect(blocked).toMatchObject({
      allowed: false,
      boundary: "effectful",
      reason: expect.stringContaining("session_compact"),
    });
    expect(summarizeEvents(runtime.events.query(sessionId))).toEqual([
      { type: "context_usage" },
      { type: "context_usage" },
      {
        type: "tool_effect_gate_selected",
        payload: {
          toolCallId: "tc-exec-compact",
          toolName: "exec",
          boundary: "effectful",
          requiresApproval: true,
          rollbackable: false,
        },
      },
      {
        type: "context_compaction_gate_blocked_tool",
        payload: {
          blockedTool: "exec",
          reason: "critical_context_pressure_without_compaction",
        },
      },
    ]);

    const compactAllowed = runtime.tools.start({
      sessionId,
      toolCallId: "tc-compact",
      toolName: "session_compact",
      args: { reason: "critical" },
      usage,
    });
    expect(compactAllowed.allowed).toBe(true);

    runtime.context.markCompacted(sessionId, {
      fromTokens: usage.tokens,
      toTokens: 40,
    });
    const unblocked = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-after-compact",
      toolName: "exec",
      args: { command: "echo ok" },
      usage,
    });
    expect(unblocked.allowed).toBe(true);
  });

  test("workspace write finish keeps finalize event order and rollback retirement semantics", () => {
    const workspace = createWorkspace("brewva-tool-char-finish-");
    mkdirSync(join(workspace, "src"), { recursive: true });
    const filePath = join(workspace, "src", "example.ts");
    writeFileSync(filePath, "export const value = 1;\n", "utf8");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: createOpsRuntimeConfig(),
    });
    const sessionId = "tool-char-finish";
    runtime.context.onTurnStart(sessionId, 1);

    const started = runtime.tools.start({
      sessionId,
      toolCallId: "tc-edit",
      toolName: "edit",
      args: {
        file_path: "src/example.ts",
        old_string: "value = 1",
        new_string: "value = 2",
      },
    });
    expect(started).toMatchObject({
      allowed: true,
      boundary: "effectful",
      mutationReceipt: {
        strategy: "workspace_patchset",
        rollbackKind: "patchset",
      },
    });

    writeFileSync(filePath, "export const value = 2;\n", "utf8");
    runtime.tools.finish({
      sessionId,
      toolCallId: "tc-edit",
      toolName: "edit",
      args: {
        file_path: "src/example.ts",
        old_string: "value = 1",
        new_string: "value = 2",
      },
      outputText: "Applied edit.",
      channelSuccess: true,
      verdict: "pass",
    });

    const directRollback = runtime.tools.rollbackLastPatchSet(sessionId);
    const mutationRollback = runtime.tools.rollbackLastMutation(sessionId);
    expect(directRollback.ok).toBe(true);
    expect(mutationRollback).toMatchObject({
      ok: false,
      reason: "no_mutation_receipt",
    });
    expect(summarizeEvents(runtime.events.query(sessionId))).toEqual([
      {
        type: "tool_effect_gate_selected",
        payload: {
          toolCallId: "tc-edit",
          toolName: "edit",
          boundary: "effectful",
          requiresApproval: false,
          rollbackable: true,
        },
      },
      {
        type: "verification_write_marked",
        payload: {
          toolName: "edit",
        },
      },
      {
        type: "projection_ingested",
      },
      {
        type: "tool_call_marked",
        payload: {
          toolName: "edit",
          toolCalls: 1,
        },
      },
      {
        type: "file_snapshot_captured",
        payload: {
          toolName: "edit",
          files: ["src/example.ts"],
        },
      },
      {
        type: "reversible_mutation_prepared",
        payload: {
          strategy: "workspace_patchset",
          rollbackKind: "patchset",
        },
      },
      {
        type: "tool_result_recorded",
        payload: {
          toolName: "edit",
          toolCallId: "tc-edit",
          verdict: "pass",
          channelSuccess: true,
          effectCommitmentRequestId: null,
          failureClass: null,
        },
      },
      {
        type: "patch_recorded",
        payload: {
          toolName: "edit",
          toolCallId: "tc-edit",
          patchChangeCount: 1,
        },
      },
      {
        type: "reversible_mutation_recorded",
        payload: {
          strategy: "workspace_patchset",
          changed: true,
          verdict: "pass",
          rollbackRefPresent: true,
        },
      },
      {
        type: "rollback",
        payload: {
          ok: true,
          mutationReceiptIdPresent: true,
          restoredPaths: ["src/example.ts"],
        },
      },
      {
        type: "verification_state_reset",
        payload: {
          reason: "rollback",
        },
      },
    ]);
  });

  test("direct recordResult keeps fallback failure classification minimal", () => {
    const runtime = createRuntime();
    const sessionId = "tool-char-record-result";

    const ledgerId = runtime.tools.recordResult({
      sessionId,
      toolCallId: "tc-fallback",
      toolName: "grep",
      args: { pattern: "foo" },
      outputText: "no matches",
      channelSuccess: false,
      verdict: "fail",
      metadata: {
        sourceEvent: "tool_execution_end",
        toolResultObserved: false,
        lifecycleFallbackReason: "tool_execution_end_without_tool_result",
      },
    });

    expect(typeof ledgerId).toBe("string");
    expect(summarizeEvents(runtime.events.query(sessionId))).toEqual([
      {
        type: "tool_result_recorded",
        payload: {
          toolName: "grep",
          toolCallId: "tc-fallback",
          verdict: "fail",
          channelSuccess: false,
          effectCommitmentRequestId: null,
          failureClass: "execution",
        },
      },
    ]);
  });
});
