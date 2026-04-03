import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRuntimeManager } from "@brewva/brewva-gateway";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("channel runtime manager", () => {
  test("forces per-agent state namespace and disables scheduler", async () => {
    const workspace = createTestWorkspace("channel-runtime-namespace");
    const controller = new BrewvaRuntime({ cwd: workspace });
    const manager = new AgentRuntimeManager({
      controllerRuntime: controller,
      maxLiveRuntimes: 4,
      idleRuntimeTtlMs: 60_000,
    });

    const runtime = await manager.getOrCreateRuntime("jack");
    expect(runtime.config.ledger.path).toBe(".brewva/agents/jack/state/ledger/evidence.jsonl");
    expect(runtime.config.projection.dir).toBe(".brewva/agents/jack/state/projection");
    expect(runtime.config.infrastructure.events.dir).toBe(".brewva/agents/jack/state/events");
    expect(runtime.config.infrastructure.turnWal.dir).toBe(".brewva/agents/jack/state/turn-wal");
    expect(runtime.config.schedule.projectionPath).toBe(
      ".brewva/agents/jack/state/schedule/intents.jsonl",
    );
    expect(runtime.config.schedule.enabled).toBe(false);
  });

  test("evicts least recently used idle runtime when pool is full", async () => {
    const workspace = createTestWorkspace("channel-runtime-lru");
    const controller = new BrewvaRuntime({ cwd: workspace });
    const manager = new AgentRuntimeManager({
      controllerRuntime: controller,
      maxLiveRuntimes: 1,
      idleRuntimeTtlMs: 60_000,
    });

    await manager.getOrCreateRuntime("jack");
    await manager.getOrCreateRuntime("mike");

    expect(manager.listRuntimes().map((entry) => entry.agentId)).toEqual(["mike"]);
  });

  test("evicts idle runtimes by ttl", async () => {
    const workspace = createTestWorkspace("channel-runtime-idle");
    const controller = new BrewvaRuntime({ cwd: workspace });
    const manager = new AgentRuntimeManager({
      controllerRuntime: controller,
      maxLiveRuntimes: 4,
      idleRuntimeTtlMs: 10,
    });

    await manager.getOrCreateRuntime("jack");
    const before = manager.listRuntimes().length;
    const evicted = manager.evictIdleRuntimes(Date.now() + 100);

    expect(before).toBe(1);
    expect(evicted).toEqual(["jack"]);
    expect(manager.listRuntimes()).toEqual([]);
  });

  test("throws when agent config overlay JSON is invalid", async () => {
    const workspace = createTestWorkspace("channel-runtime-invalid-config");
    const controller = new BrewvaRuntime({ cwd: workspace });
    const manager = new AgentRuntimeManager({
      controllerRuntime: controller,
      maxLiveRuntimes: 4,
      idleRuntimeTtlMs: 60_000,
    });

    const agentRoot = join(workspace, ".brewva", "agents", "jack");
    mkdirSync(agentRoot, { recursive: true });
    writeFileSync(join(agentRoot, "config.json"), "{ invalid", "utf8");

    try {
      await manager.getOrCreateRuntime("jack");
      expect.unreachable("expected invalid agent config to throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("invalid_agent_config:jack:");
    }
  });

  test("loads agent config overlay from JSONC", async () => {
    const workspace = createTestWorkspace("channel-runtime-jsonc-config");
    const controller = new BrewvaRuntime({ cwd: workspace });
    const manager = new AgentRuntimeManager({
      controllerRuntime: controller,
      maxLiveRuntimes: 4,
      idleRuntimeTtlMs: 60_000,
    });

    const agentRoot = join(workspace, ".brewva", "agents", "jack");
    mkdirSync(agentRoot, { recursive: true });
    writeFileSync(
      join(agentRoot, "config.json"),
      [
        "{",
        "  // agent-local projection override",
        '  "projection": {',
        '    "workingFile": "agent-working.md",',
        "  },",
        "}",
      ].join("\n"),
      "utf8",
    );

    const runtime = await manager.getOrCreateRuntime("jack");
    expect(runtime.config.projection.workingFile).toBe("agent-working.md");
  });

  test("throws when agent config overlay root is not an object", async () => {
    const workspace = createTestWorkspace("channel-runtime-non-object-config");
    const controller = new BrewvaRuntime({ cwd: workspace });
    const manager = new AgentRuntimeManager({
      controllerRuntime: controller,
      maxLiveRuntimes: 4,
      idleRuntimeTtlMs: 60_000,
    });

    const agentRoot = join(workspace, ".brewva", "agents", "jack");
    mkdirSync(agentRoot, { recursive: true });
    writeFileSync(join(agentRoot, "config.json"), '["invalid"]', "utf8");

    try {
      await manager.getOrCreateRuntime("jack");
      expect.unreachable("expected non-object agent config to throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("invalid_agent_config:jack:root must be an object");
    }
  });
});
