import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolvePrimaryTaskTargetRoot,
  resolveTaskTargetRoots,
} from "../../../packages/brewva-runtime/src/task/targeting.js";

describe("task targeting", () => {
  test("bounds in-workspace ancestor resolution to the workspace root", () => {
    const container = mkdtempSync(join(tmpdir(), "brewva-task-targeting-container-"));
    mkdirSync(join(container, ".git"), { recursive: true });
    const workspace = join(container, "workspace");
    const nestedDir = join(workspace, "packages", "service");
    mkdirSync(nestedDir, { recursive: true });
    const targetFile = join(nestedDir, "index.ts");
    writeFileSync(targetFile, "export const service = true;\n", "utf8");

    const roots = resolveTaskTargetRoots({
      cwd: workspace,
      workspaceRoot: workspace,
      spec: {
        schema: "brewva.task.v1",
        goal: "Keep repository discovery inside the configured workspace.",
        targets: {
          files: [targetFile],
        },
      },
    });

    expect(roots).toEqual([nestedDir]);
    expect(
      resolvePrimaryTaskTargetRoot({
        cwd: workspace,
        workspaceRoot: workspace,
        spec: {
          schema: "brewva.task.v1",
          goal: "Keep repository discovery inside the configured workspace.",
          targets: {
            files: [targetFile],
          },
        },
      }),
    ).toBe(nestedDir);
  });
});
