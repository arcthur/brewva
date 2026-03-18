import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createTaskLedgerTools } from "@brewva/brewva-tools";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";
import { extractTextContent, fakeContext } from "./tools-flow.helpers.js";

function createTaskLedgerToolHarness(prefix: string) {
  const workspace = createTestWorkspace(prefix);
  const runtime = new BrewvaRuntime({ cwd: workspace });
  const tools = createTaskLedgerTools({ runtime });

  const findTool = (name: string) => {
    const tool = tools.find((entry) => entry.name === name);
    expect(tool, `missing tool ${name}`).toBeDefined();
    return tool!;
  };

  return {
    workspace,
    runtime,
    taskSetSpec: findTool("task_set_spec"),
    taskAddItem: findTool("task_add_item"),
    taskUpdateItem: findTool("task_update_item"),
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

describe("task ledger tool aliases", () => {
  test("task_set_spec exposes agent-facing verification levels and lowers them to runtime values", async () => {
    const { workspace, runtime, taskSetSpec } = createTaskLedgerToolHarness(
      "task-ledger-tool-set-spec",
    );

    try {
      const sessionId = "task-ledger-tool-set-spec";
      const inspectionInput = {
        goal: "Review docs",
        verification: {
          level: "inspection",
          commands: ["bun test test/quality/docs"],
        },
      };
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
      expect(readLiteralUnionValues(verificationLevelSchema)).toContain("inspection");
      expect(readLiteralUnionValues(verificationLevelSchema)).toContain("smoke");
      expect(readLiteralUnionValues(verificationLevelSchema)).toContain("targeted");
      expect(readLiteralUnionValues(verificationLevelSchema)).toContain("full");
      expect(readLiteralUnionValues(verificationLevelSchema)).not.toContain("standard");

      const inspectionResult = await taskSetSpec.execute(
        "tc-task-set-spec-inspection-alias",
        inspectionInput,
        undefined,
        undefined,
        fakeContext(sessionId),
      );

      expect(extractTextContent(inspectionResult)).toBe("TaskSpec recorded.");
      expect(runtime.task.getState(sessionId).spec?.verification).toEqual({
        commands: ["bun test test/quality/docs"],
      });

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
      expect(readLiteralUnionValues(statusSchema)).toContain("in-progress");
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
        status: "in-progress",
      };

      const statusSchema = (
        taskUpdateItem.parameters as {
          properties?: {
            status?: unknown;
          };
        }
      ).properties?.status;
      expect(readLiteralUnionValues(statusSchema)).toContain("in-progress");

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
});
