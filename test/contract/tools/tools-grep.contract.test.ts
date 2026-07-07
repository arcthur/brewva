import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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

  test("rejects explicit runtime tape search paths before spawning grep", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-grep-runtime-tape-"));
    mkdirSync(join(workspace, ".brewva", "tape"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva", "tape", "session.jsonl"),
      `${JSON.stringify({
        id: "evt-tape",
        sessionId: "tc-grep-runtime-tape",
        type: "turn.started",
        timestamp: 1,
        payload: {
          prompt: "needle",
          content: [{ type: "text", text: "needle" }],
        },
      })}\n`,
      "utf8",
    );
    const runtime = createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }));
    const tool = createGrepTool({ runtime });

    const result = await tool.execute(
      "tc-grep-runtime-tape",
      {
        query: "needle",
        paths: [".brewva/tape"],
      },
      undefined,
      undefined,
      fakeContext("tc-grep-runtime-tape"),
    );

    expect(result.outcome.kind).toBe("err");
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("runtime artifact");
    expect(toolOutcomePayload(result)).toMatchObject({
      reason: "runtime_artifact_read_denied",
      path: ".brewva/tape",
    });
  });

  test("rejects explicit runtime tape glob filters before spawning grep", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-grep-runtime-tape-glob-"));
    mkdirSync(join(workspace, ".brewva", "tape"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva", "tape", "session.jsonl"),
      `${JSON.stringify({
        id: "evt-tape-glob",
        sessionId: "tc-grep-runtime-tape-glob",
        type: "turn.started",
        timestamp: 1,
        payload: {
          prompt: "needle",
          content: [{ type: "text", text: "needle" }],
        },
      })}\n`,
      "utf8",
    );
    const runtime = createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }));
    const tool = createGrepTool({ runtime });

    const result = await tool.execute(
      "tc-grep-runtime-tape-glob",
      {
        query: "needle",
        paths: ["."],
        glob: ".brewva/tape/**",
      },
      undefined,
      undefined,
      fakeContext("tc-grep-runtime-tape-glob"),
    );

    expect(result.outcome.kind).toBe("err");
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("runtime artifact");
    expect(toolOutcomePayload(result)).toMatchObject({
      reason: "runtime_artifact_read_denied",
      glob: ".brewva/tape/**",
    });
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

  test("glob rejects explicit runtime tape patterns before spawning search", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-glob-runtime-tape-"));
    mkdirSync(join(workspace, ".brewva", "tape"), { recursive: true });
    const runtime = createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }));
    const tool = requireDefined(
      buildBrewvaTools({ runtime }).find((candidate) => candidate.name === "glob"),
      "expected glob tool",
    );

    const result = await tool.execute(
      "tc-glob-runtime-tape",
      {
        pattern: ".brewva/tape/**",
      },
      undefined,
      undefined,
      fakeContext("tc-glob-runtime-tape"),
    );

    expect(result.outcome.kind).toBe("err");
    expect(
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }),
    ).toContain("runtime artifact");
    expect(toolOutcomePayload(result)).toMatchObject({
      reason: "runtime_artifact_read_denied",
      pattern: ".brewva/tape/**",
    });
  });

  test("glob rejects explicit runtime tape paths before spawning search", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-glob-runtime-tape-path-"));
    mkdirSync(join(workspace, ".brewva", "tape"), { recursive: true });
    const runtime = createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }));
    const tool = requireDefined(
      buildBrewvaTools({ runtime }).find((candidate) => candidate.name === "glob"),
      "expected glob tool",
    );

    const result = await tool.execute(
      "tc-glob-runtime-tape-path",
      {
        pattern: "**/*",
        paths: [".brewva/tape"],
      },
      undefined,
      undefined,
      fakeContext("tc-glob-runtime-tape-path"),
    );

    expect(result.outcome.kind).toBe("err");
    expect(
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }),
    ).toContain("runtime artifact");
    expect(toolOutcomePayload(result)).toMatchObject({
      reason: "runtime_artifact_read_denied",
      path: ".brewva/tape",
    });
  });

  test("glob workdir rejection includes the rejected path and recovery guidance", async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "brewva-glob-workdir-")));
    const outsideRoot = realpathSync(mkdtempSync(join(tmpdir(), "brewva-glob-outside-")));
    const runtime = createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }));
    const tool = requireDefined(
      buildBrewvaTools({ runtime }).find((candidate) => candidate.name === "glob"),
      "expected glob tool",
    );

    const result = await tool.execute(
      "tc-glob-workdir-rejection",
      {
        pattern: "**/*",
        workdir: outsideRoot,
      },
      undefined,
      undefined,
      fakeContext("tc-glob-workdir-rejection"),
    );

    expect(result.outcome.kind).toBe("err");
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain(`glob rejected: workdir escapes target roots (${workspace}).`);
    expect(text).toContain(`Rejected workdir: ${outsideRoot}`);
    expect(text).toContain("Stay inside a target root");
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
