import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, type TaskSpec } from "@brewva/brewva-runtime";
import { requireDefined, requireNonEmptyString, requireRecord } from "../../helpers/assertions.js";

function createWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "brewva-reversible-mutation-"));
}

describe("reversible mutation receipts", () => {
  test("task mutations stay audit-only and do not emit rollback receipts", () => {
    const workspace = createWorkspace();
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `reversible-task-${crypto.randomUUID()}`;
    runtime.context.onTurnStart(sessionId, 1);

    const started = runtime.tools.start({
      sessionId,
      toolCallId: "tc-task-set-spec",
      toolName: "task_set_spec",
      args: {
        goal: "Implement the new runtime effect gate model",
      },
    });

    expect(started.allowed).toBe(true);
    expect(started.boundary).toBe("effectful");
    expect(started.mutationReceipt).toBeUndefined();

    const nextSpec: TaskSpec = {
      schema: "brewva.task.v1",
      goal: "Implement the new runtime effect gate model",
    };
    runtime.task.setSpec(sessionId, nextSpec);
    runtime.tools.finish({
      sessionId,
      toolCallId: "tc-task-set-spec",
      toolName: "task_set_spec",
      args: {
        goal: nextSpec.goal,
      },
      outputText: "TaskSpec recorded.",
      channelSuccess: true,
      verdict: "pass",
    });

    const receiptEvent = runtime.events.query(sessionId, {
      type: "reversible_mutation_recorded",
      last: 1,
    })[0];
    expect(receiptEvent).toBeUndefined();
    expect(runtime.task.getState(sessionId).spec?.goal).toBe(nextSpec.goal);
  });

  test("workspace mutations emit patchset-backed reversible receipts", () => {
    const workspace = createWorkspace();
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "example.ts"), "export const value = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `reversible-workspace-${crypto.randomUUID()}`;
    runtime.context.onTurnStart(sessionId, 1);

    const started = runtime.tools.start({
      sessionId,
      toolCallId: "tc-edit-example",
      toolName: "edit",
      args: {
        file_path: "src/example.ts",
        old_string: "value = 1",
        new_string: "value = 2",
      },
    });

    expect(started.allowed).toBe(true);
    expect(started.boundary).toBe("effectful");
    expect(started.mutationReceipt?.strategy).toBe("workspace_patchset");
    expect(started.mutationReceipt?.rollbackKind).toBe("patchset");

    writeFileSync(join(workspace, "src", "example.ts"), "export const value = 2;\n", "utf8");
    runtime.tools.finish({
      sessionId,
      toolCallId: "tc-edit-example",
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

    const receiptEvent = requireDefined(
      runtime.events.query(sessionId, {
        type: "reversible_mutation_recorded",
        last: 1,
      })[0],
      "expected reversible_mutation_recorded event",
    );
    const receiptPayload = receiptEvent.payload as {
      receipt?: unknown;
      changed?: boolean;
      patchSetId?: unknown;
      rollbackRef?: unknown;
    };
    requireRecord(receiptPayload.receipt, "expected reversible mutation receipt payload");
    expect(receiptPayload.changed).toBe(true);
    requireNonEmptyString(receiptPayload.patchSetId, "missing patchSetId for reversible mutation");
    expect(
      requireNonEmptyString(receiptPayload.rollbackRef, "missing rollbackRef").startsWith(
        "patchset://",
      ),
    ).toBe(true);
  });

  test("task mutations do not enter runtime.tools.rollbackLastMutation", () => {
    const workspace = createWorkspace();
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `reversible-task-rollback-${crypto.randomUUID()}`;
    runtime.context.onTurnStart(sessionId, 1);

    runtime.tools.start({
      sessionId,
      toolCallId: "tc-task-set-spec-rollback",
      toolName: "task_set_spec",
      args: {
        goal: "Apply and rollback task state",
      },
    });

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Apply and rollback task state",
    });
    runtime.tools.finish({
      sessionId,
      toolCallId: "tc-task-set-spec-rollback",
      toolName: "task_set_spec",
      args: {
        goal: "Apply and rollback task state",
      },
      outputText: "TaskSpec recorded.",
      channelSuccess: true,
      verdict: "pass",
    });

    const rollback = runtime.tools.rollbackLastMutation(sessionId);
    expect(rollback.ok).toBe(false);
    expect(rollback.reason).toBe("no_mutation_receipt");
    expect(runtime.task.getState(sessionId).spec?.goal).toBe("Apply and rollback task state");

    const rollbackEvent = runtime.events.query(sessionId, {
      type: "reversible_mutation_rolled_back",
      last: 1,
    })[0];
    expect(rollbackEvent).toBeUndefined();
  });

  test("workspace patchset mutations can be rolled back through runtime.tools.rollbackLastMutation", () => {
    const workspace = createWorkspace();
    mkdirSync(join(workspace, "src"), { recursive: true });
    const filePath = join(workspace, "src", "rollback.ts");
    writeFileSync(filePath, "export const value = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `reversible-workspace-rollback-${crypto.randomUUID()}`;
    runtime.context.onTurnStart(sessionId, 1);

    runtime.tools.start({
      sessionId,
      toolCallId: "tc-edit-rollback",
      toolName: "edit",
      args: {
        file_path: "src/rollback.ts",
        old_string: "value = 1",
        new_string: "value = 2",
      },
    });

    writeFileSync(filePath, "export const value = 2;\n", "utf8");
    runtime.tools.finish({
      sessionId,
      toolCallId: "tc-edit-rollback",
      toolName: "edit",
      args: {
        file_path: "src/rollback.ts",
        old_string: "value = 1",
        new_string: "value = 2",
      },
      outputText: "Applied edit.",
      channelSuccess: true,
      verdict: "pass",
    });

    const rollback = runtime.tools.rollbackLastMutation(sessionId);
    expect(rollback.ok).toBe(true);
    expect(rollback.strategy).toBe("workspace_patchset");
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 1;\n");
  });

  test("workspace mutation receipts rehydrate from tape and remain rollbackable after restart", () => {
    const workspace = createWorkspace();
    mkdirSync(join(workspace, "src"), { recursive: true });
    const filePath = join(workspace, "src", "restart-rollback.ts");
    writeFileSync(filePath, "export const value = 1;\n", "utf8");

    const sessionId = `reversible-workspace-restart-${crypto.randomUUID()}`;
    const firstRuntime = new BrewvaRuntime({ cwd: workspace });
    firstRuntime.context.onTurnStart(sessionId, 1);

    const started = firstRuntime.tools.start({
      sessionId,
      toolCallId: "tc-edit-restart-rollback",
      toolName: "edit",
      args: {
        file_path: "src/restart-rollback.ts",
        old_string: "value = 1",
        new_string: "value = 2",
      },
    });
    expect(started.allowed).toBe(true);
    expect(started.mutationReceipt?.strategy).toBe("workspace_patchset");

    writeFileSync(filePath, "export const value = 2;\n", "utf8");
    firstRuntime.tools.finish({
      sessionId,
      toolCallId: "tc-edit-restart-rollback",
      toolName: "edit",
      args: {
        file_path: "src/restart-rollback.ts",
        old_string: "value = 1",
        new_string: "value = 2",
      },
      outputText: "Applied edit before restart.",
      channelSuccess: true,
      verdict: "pass",
    });

    const restartedRuntime = new BrewvaRuntime({ cwd: workspace });
    restartedRuntime.context.onTurnStart(sessionId, 2);

    const rollback = restartedRuntime.tools.rollbackLastMutation(sessionId);
    expect(rollback.ok).toBe(true);
    expect(rollback.strategy).toBe("workspace_patchset");
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 1;\n");
  });

  test("acceptance closure writes do not create rollback receipts", () => {
    const workspace = createWorkspace();
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `reversible-acceptance-${crypto.randomUUID()}`;
    runtime.context.onTurnStart(sessionId, 1);

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Close with operator acceptance",
      acceptance: {
        required: true,
        owner: "operator",
      },
    });

    const started = runtime.tools.start({
      sessionId,
      toolCallId: "tc-task-record-acceptance",
      toolName: "task_record_acceptance",
      args: {
        status: "accepted",
        decidedBy: "operator",
      },
    });

    expect(started.allowed).toBe(true);
    expect(started.mutationReceipt).toBeUndefined();

    runtime.task.recordAcceptance(sessionId, {
      status: "accepted",
      decidedBy: "operator",
    });
    runtime.tools.finish({
      sessionId,
      toolCallId: "tc-task-record-acceptance",
      toolName: "task_record_acceptance",
      args: {
        status: "accepted",
        decidedBy: "operator",
      },
      outputText: "Acceptance state recorded (accepted).",
      channelSuccess: true,
      verdict: "pass",
    });

    expect(
      runtime.events.query(sessionId, {
        type: "reversible_mutation_recorded",
      }),
    ).toHaveLength(0);
    expect(runtime.task.getState(sessionId).acceptance?.status).toBe("accepted");
  });

  test("direct patchset rollback also retires the matching reversible mutation receipt", () => {
    const workspace = createWorkspace();
    mkdirSync(join(workspace, "src"), { recursive: true });
    const filePath = join(workspace, "src", "direct-rollback.ts");
    writeFileSync(filePath, "export const value = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = `reversible-workspace-direct-${crypto.randomUUID()}`;
    runtime.context.onTurnStart(sessionId, 1);

    runtime.tools.start({
      sessionId,
      toolCallId: "tc-edit-direct-rollback",
      toolName: "edit",
      args: {
        file_path: "src/direct-rollback.ts",
        old_string: "value = 1",
        new_string: "value = 2",
      },
    });

    writeFileSync(filePath, "export const value = 2;\n", "utf8");
    runtime.tools.finish({
      sessionId,
      toolCallId: "tc-edit-direct-rollback",
      toolName: "edit",
      args: {
        file_path: "src/direct-rollback.ts",
        old_string: "value = 1",
        new_string: "value = 2",
      },
      outputText: "Applied edit.",
      channelSuccess: true,
      verdict: "pass",
    });

    const directRollback = runtime.tools.rollbackLastPatchSet(sessionId);
    expect(directRollback.ok).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 1;\n");

    const mutationRollback = runtime.tools.rollbackLastMutation(sessionId);
    expect(mutationRollback.ok).toBe(false);
    expect(mutationRollback.reason).toBe("no_mutation_receipt");
  });
});
