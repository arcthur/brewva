import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createTaskLedgerTools } from "@brewva/brewva-tools";
import { requireDefined } from "../../helpers/assertions.js";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";
import { extractTextContent, fakeContext } from "./tools-flow.helpers.js";

function createTaskLedgerToolHarness(prefix: string) {
  const workspace = createTestWorkspace(prefix);
  const runtime = new BrewvaRuntime({ cwd: workspace });
  const tools = createTaskLedgerTools({ runtime });

  const findTool = (name: string) =>
    requireDefined(
      tools.find((entry) => entry.name === name),
      `missing tool ${name}`,
    );

  return {
    workspace,
    runtime,
    taskSetSpec: findTool("task_set_spec"),
    taskAddItem: findTool("task_add_item"),
    taskUpdateItem: findTool("task_update_item"),
    taskRecordAcceptance: findTool("task_record_acceptance"),
  };
}

function readLiteralUnionValues(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") {
    return [];
  }

  const anyOf = (schema as { anyOf?: unknown[] }).anyOf;
  if (!Array.isArray(anyOf)) {
    return [];
  }

  return anyOf
    .map((entry) =>
      entry && typeof entry === "object" && typeof (entry as { const?: unknown }).const === "string"
        ? (entry as { const: string }).const
        : null,
    )
    .filter((value): value is string => value !== null);
}

describe("task ledger tool contracts", () => {
  test("task_set_spec exposes canonical agent-facing verification levels and lowers them to runtime values", async () => {
    const { workspace, runtime, taskSetSpec } = createTaskLedgerToolHarness(
      "task-ledger-tool-set-spec",
    );

    try {
      const sessionId = "task-ledger-tool-set-spec";
      const smokeInput = {
        goal: "Review docs",
        verification: {
          level: "smoke",
          commands: ["bun test test/quality/docs"],
        },
      };
      const targetedInput = {
        goal: "Review docs",
        verification: {
          level: "targeted",
          commands: ["bun test test/quality/docs"],
        },
      };
      const fullInput = {
        goal: "Review docs",
        verification: {
          level: "full",
          commands: ["bun test test/quality/docs"],
        },
      };

      const verificationLevelSchema = (
        taskSetSpec.parameters as {
          properties?: {
            verification?: {
              properties?: {
                level?: unknown;
              };
            };
          };
        }
      ).properties?.verification?.properties?.level;
      expect(readLiteralUnionValues(verificationLevelSchema)).toContain("none");
      expect(readLiteralUnionValues(verificationLevelSchema)).toContain("smoke");
      expect(readLiteralUnionValues(verificationLevelSchema)).toContain("targeted");
      expect(readLiteralUnionValues(verificationLevelSchema)).toContain("full");
      expect(readLiteralUnionValues(verificationLevelSchema)).not.toContain("standard");

      await taskSetSpec.execute(
        "tc-task-set-spec-smoke-alias",
        smokeInput,
        undefined,
        undefined,
        fakeContext(sessionId),
      );
      expect(runtime.task.getState(sessionId).spec?.verification).toEqual({
        level: "quick",
        commands: ["bun test test/quality/docs"],
      });

      await taskSetSpec.execute(
        "tc-task-set-spec-targeted-alias",
        targetedInput,
        undefined,
        undefined,
        fakeContext(sessionId),
      );
      expect(runtime.task.getState(sessionId).spec?.verification).toEqual({
        level: "standard",
        commands: ["bun test test/quality/docs"],
      });

      await taskSetSpec.execute(
        "tc-task-set-spec-full-alias",
        fullInput,
        undefined,
        undefined,
        fakeContext(sessionId),
      );
      expect(runtime.task.getState(sessionId).spec?.verification).toEqual({
        level: "strict",
        commands: ["bun test test/quality/docs"],
      });
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });

  test("task_add_item exposes agent-facing statuses and lowers them to runtime values", async () => {
    const { workspace, runtime, taskAddItem } = createTaskLedgerToolHarness(
      "task-ledger-tool-add-item",
    );

    try {
      const sessionId = "task-ledger-tool-add-item";
      const input = {
        text: "Audit docs navigation",
        status: "in_progress",
      };

      const statusSchema = (
        taskAddItem.parameters as {
          properties?: {
            status?: unknown;
          };
        }
      ).properties?.status;
      expect(readLiteralUnionValues(statusSchema)).toContain("pending");
      expect(readLiteralUnionValues(statusSchema)).toContain("in_progress");
      expect(readLiteralUnionValues(statusSchema)).not.toContain("doing");

      const result = await taskAddItem.execute(
        "tc-task-add-item-alias",
        input,
        undefined,
        undefined,
        fakeContext(sessionId),
      );

      expect(extractTextContent(result)).toContain("Task item added");
      expect(runtime.task.getState(sessionId).items[0]?.status).toBe("doing");
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });

  test("task_update_item shares the same agent-facing status lowering", async () => {
    const { workspace, runtime, taskUpdateItem } = createTaskLedgerToolHarness(
      "task-ledger-tool-update-item",
    );

    try {
      const sessionId = "task-ledger-tool-update-item";
      runtime.task.addItem(sessionId, {
        id: "item-1",
        text: "Publish doc fixes",
        status: "todo",
      });

      const input = {
        id: "item-1",
        status: "in_progress",
      };

      const statusSchema = (
        taskUpdateItem.parameters as {
          properties?: {
            status?: unknown;
          };
        }
      ).properties?.status;
      expect(readLiteralUnionValues(statusSchema)).toContain("in_progress");

      const result = await taskUpdateItem.execute(
        "tc-task-update-item-alias",
        input,
        undefined,
        undefined,
        fakeContext(sessionId),
      );

      expect(extractTextContent(result)).toBe("Task item updated.");
      expect(runtime.task.getState(sessionId).items[0]?.status).toBe("doing");
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });

  test("task_record_acceptance records operator-visible acceptance state", async () => {
    const { workspace, runtime, taskSetSpec, taskRecordAcceptance } = createTaskLedgerToolHarness(
      "task-ledger-tool-acceptance",
    );

    try {
      const sessionId = "task-ledger-tool-acceptance";
      await taskSetSpec.execute(
        "tc-task-set-spec-acceptance",
        {
          goal: "Ship the closure UX",
          acceptance: {
            required: true,
            owner: "operator",
            criteria: ["Operator confirms the result is acceptable."],
          },
        },
        undefined,
        undefined,
        fakeContext(sessionId),
      );

      const result = await taskRecordAcceptance.execute(
        "tc-task-record-acceptance",
        {
          status: "accepted",
          decidedBy: "operator",
          notes: "Closure accepted after inspection.",
        },
        undefined,
        undefined,
        fakeContext(sessionId),
      );

      expect(extractTextContent(result)).toBe("Acceptance state recorded (accepted).");
      expect(runtime.task.getState(sessionId).acceptance).toEqual({
        status: "accepted",
        decidedBy: "operator",
        notes: "Closure accepted after inspection.",
        updatedAt: expect.any(Number),
      });
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });

  test("task_record_acceptance rejects writes when acceptance is not enabled on the task", async () => {
    const { workspace, runtime, taskSetSpec, taskRecordAcceptance } = createTaskLedgerToolHarness(
      "task-ledger-tool-acceptance-disabled",
    );

    try {
      const sessionId = "task-ledger-tool-acceptance-disabled";
      await taskSetSpec.execute(
        "tc-task-set-spec-no-acceptance",
        {
          goal: "Keep closure verification-only",
        },
        undefined,
        undefined,
        fakeContext(sessionId),
      );

      const result = await taskRecordAcceptance.execute(
        "tc-task-record-acceptance-disabled",
        {
          status: "accepted",
          decidedBy: "operator",
        },
        undefined,
        undefined,
        fakeContext(sessionId),
      );

      expect(extractTextContent(result)).toBe(
        "Acceptance update rejected (acceptance_not_enabled).",
      );
      expect(runtime.task.getState(sessionId).acceptance).toBeUndefined();
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });

  test("removed verification and status aliases are no longer exposed", () => {
    const { workspace, taskSetSpec, taskAddItem } = createTaskLedgerToolHarness(
      "task-ledger-tool-canonical-only",
    );

    try {
      const verificationLevelSchema = (
        taskSetSpec.parameters as {
          properties?: {
            verification?: {
              properties?: {
                level?: unknown;
              };
            };
          };
        }
      ).properties?.verification?.properties?.level;
      const statusSchema = (
        taskAddItem.parameters as {
          properties?: {
            status?: unknown;
          };
        }
      ).properties?.status;
      expect(readLiteralUnionValues(verificationLevelSchema)).not.toContain("inspection");
      expect(readLiteralUnionValues(verificationLevelSchema)).not.toContain("investigate");
      expect(readLiteralUnionValues(statusSchema)).not.toContain("in-progress");
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });
});
