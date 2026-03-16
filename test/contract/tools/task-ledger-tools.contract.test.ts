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
  test("task_set_spec accepts verification level aliases and stores canonical values", async () => {
    const { workspace, runtime, taskSetSpec } = createTaskLedgerToolHarness(
      "task-ledger-tool-set-spec",
    );

    try {
      const sessionId = "task-ledger-tool-set-spec";
      const input = {
        goal: "Review docs",
        verification: {
          level: "none",
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
      expect(readLiteralUnionValues(verificationLevelSchema)).not.toContain("off");

      const result = await taskSetSpec.execute(
        "tc-task-set-spec-alias",
        input,
        undefined,
        undefined,
        fakeContext(sessionId),
      );

      expect(extractTextContent(result)).toBe("TaskSpec recorded.");
      expect(runtime.task.getState(sessionId).spec?.verification).toEqual({
        commands: ["bun test test/quality/docs"],
      });
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });

  test("task_add_item accepts in-progress aliases and records canonical status", async () => {
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
      expect(readLiteralUnionValues(statusSchema)).toContain("in_progress");
      expect(readLiteralUnionValues(statusSchema)).toContain("in-progress");
      expect(readLiteralUnionValues(statusSchema)).not.toContain("pending");
      expect(readLiteralUnionValues(statusSchema)).not.toContain("completed");

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

  test("task_update_item shares the same status alias normalization", async () => {
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
