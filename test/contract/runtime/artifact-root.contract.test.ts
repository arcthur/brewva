import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("runtime artifact root resolution", () => {
  test("uses nearest repository/config root for .orchestrator artifacts", () => {
    const workspace = createTestWorkspace("artifact-root-with-git");
    mkdirSync(join(workspace, "packages", "demo"), { recursive: true });
    mkdirSync(join(workspace, ".git"), { recursive: true });
    const nestedCwd = join(workspace, "packages", "demo");

    const runtime = createBrewvaRuntime({ cwd: nestedCwd }).hosted;
    const sessionId = "artifact-root-1";

    runtime.extensions.hosted.events.record({
      sessionId,
      type: "session_start",
    });
    runtime.authority.tools.invocation.recordResult({
      sessionId,
      toolName: "read",
      args: { file_path: "README.md" },
      outputText: "ok",
      channelSuccess: true,
    });

    expect(runtime.identity.workspaceRoot).toBe(workspace);
    expect(runtime.inspect.ledger.store.getPath()).toBe(
      join(workspace, ".orchestrator", "ledger", "evidence.jsonl"),
    );
    const eventsRoot = join(workspace, ".orchestrator", "events");
    const eventFiles = readdirSync(eventsRoot).filter((name) => name.endsWith(".jsonl"));
    expect(eventFiles.length).toBeGreaterThan(0);
    expect(existsSync(join(nestedCwd, ".orchestrator"))).toBe(false);
  });

  test("falls back to cwd when no root marker exists", () => {
    const workspace = createTestWorkspace("artifact-root-no-marker");
    mkdirSync(join(workspace, "packages", "demo"), { recursive: true });
    const nestedCwd = join(workspace, "packages", "demo");

    const runtime = createBrewvaRuntime({ cwd: nestedCwd }).hosted;
    expect(runtime.identity.workspaceRoot).toBe(nestedCwd);
  });
});
