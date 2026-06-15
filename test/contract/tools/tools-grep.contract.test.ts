import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBrewvaTools } from "@brewva/brewva-tools";
import { createGrepTool } from "@brewva/brewva-tools/navigation";
import { requireDefined } from "../../helpers/assertions.js";
import {
  createBundledToolRuntime,
  createRuntimeFixture,
  createRuntimeInstanceFixture,
} from "../../helpers/runtime.js";
import { toolOutcomePayload } from "../../helpers/tool-outcome.js";
import { extractTextContent, fakeContext } from "./tools-flow.helpers.js";

describe("grep managed tool", () => {
  test("records source snapshots for matched lines under scoped runtime capabilities", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-grep-"));
    writeFileSync(
      join(workspace, "example.ts"),
      ["export const approval = 'approval-and-rollback';", ""].join("\n"),
      "utf8",
    );
    const runtime = createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }));
    const tool = createGrepTool({ runtime });

    const result = await tool.execute(
      "tc-grep-source-snapshot",
      {
        query: "approval-and-rollback",
        paths: ["."],
      },
      undefined,
      undefined,
      fakeContext("tc-grep-source-snapshot"),
    );

    expect(result.outcome.kind).toBe("ok");
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    const details = toolOutcomePayload(result) as { snapshots?: Array<{ id: string }> };
    expect(text).toMatch(/snapshot: snap_/u);
    expect(details.snapshots).toHaveLength(1);
  });

  test("accepts a single glob string from model tool calls", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-grep-string-glob-"));
    writeFileSync(join(workspace, "notes.md"), "approval-and-rollback\n", "utf8");
    writeFileSync(join(workspace, "notes.ts"), "approval-and-rollback\n", "utf8");
    const runtime = createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }));
    const tool = createGrepTool({ runtime });

    const result = await tool.execute(
      "tc-grep-string-glob",
      {
        query: "approval-and-rollback",
        glob: "**/*.md",
      },
      undefined,
      undefined,
      fakeContext("tc-grep-string-glob"),
    );

    expect(result.outcome.kind).toBe("ok");
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("notes.md");
    expect(text).not.toContain("notes.ts");
  });

  test("bundles a bounded glob tool for file discovery", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-glob-"));
    writeFileSync(join(workspace, "approval-and-rollback.md"), "# plan\n", "utf8");
    writeFileSync(join(workspace, "other.md"), "# other\n", "utf8");
    const runtime = createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }));
    const tool = requireDefined(
      buildBrewvaTools({ runtime }).find((candidate) => candidate.name === "glob"),
      "expected glob tool",
    );
    expect(tool.name).toBe("glob");

    const result = await tool.execute(
      "tc-glob-discovery",
      {
        pattern: "**/approval-and-rollback*",
      },
      undefined,
      undefined,
      fakeContext("tc-glob-discovery"),
    );

    expect(result.outcome.kind).toBe("ok");
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("approval-and-rollback.md");
    expect(text).not.toContain("other.md");
  });

  test("allows glob paths from canonical turn prompts that mention sibling roots", async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "brewva-glob-workspace-")));
    const siblingRoot = realpathSync(mkdtempSync(join(tmpdir(), "brewva-glob-sibling-")));
    writeFileSync(join(siblingRoot, "approval-notes.md"), "# approval\n", "utf8");
    const sessionId = "tc-glob-canonical-prompt-root";
    const promptText = `Compare ${siblingRoot} against this workspace before setting TaskSpec targets.`;
    const runtime = createBundledToolRuntime(
      createRuntimeFixture({
        ops: {
          events: {
            records: {
              query: (_sessionId, query?: { type?: string }) =>
                query?.type === "turn.started"
                  ? [
                      {
                        id: "evt-turn-started-test",
                        sessionId,
                        type: "turn.started",
                        timestamp: 0,
                        payload: {
                          prompt: promptText,
                          content: [{ type: "text", text: promptText }],
                          mode: "interactive",
                        },
                      },
                    ]
                  : [],
            },
          },
          task: {
            target: {
              getDescriptor: () => ({
                primaryRoot: workspace,
                roots: [workspace],
              }),
            },
          },
        },
      }),
    );
    const tool = requireDefined(
      buildBrewvaTools({ runtime }).find((candidate) => candidate.name === "glob"),
      "expected glob tool",
    );

    const result = await tool.execute(
      "tc-glob-canonical-prompt-root",
      {
        pattern: "**/*approval*",
        paths: [siblingRoot],
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    expect(result.outcome.kind).toBe("ok");
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("approval-notes.md");
  });
});
