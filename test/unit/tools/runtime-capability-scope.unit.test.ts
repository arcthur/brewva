import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  BrewvaToolRequiredCapability,
  BrewvaToolRuntime,
} from "@brewva/brewva-tools/contracts";
import {
  BREWVA_TOOL_RUNTIME_CAPABILITY_PATHS,
  TOOL_REQUIRED_CAPABILITIES_BY_NAME,
  createCapabilityScopedToolRuntime,
} from "@brewva/brewva-tools/registry";
import {
  collectCapabilityPaths,
  collectWorkspaceSourcePathMappings,
} from "../../../script/generate-tool-runtime-capability-inventory.js";

const repoRoot = resolve(import.meta.dir, "../../..");

function acceptCapabilityCanary(_capability: BrewvaToolRequiredCapability): void {}

acceptCapabilityCanary("authority.tools.resourceLeases.request");
// @ts-expect-error operator ports are not managed tool runtime capabilities.
acceptCapabilityCanary("operator.context.lifecycle.onTurnStart");
// @ts-expect-error nonexistent paths are not managed tool runtime capabilities.
acceptCapabilityCanary("inspect.context.missing.nope");

function createToolRuntimeFixture(): BrewvaToolRuntime {
  return {
    identity: {
      cwd: "/tmp/brewva",
      workspaceRoot: "/tmp/brewva",
      agentId: "agent-test",
    },
    config: {} as BrewvaToolRuntime["config"],
    authority: {
      workbench: {
        note(sessionId: string) {
          return {
            id: "note-1",
            kind: "note",
            content: "note",
            sourceRefs: [],
            reason: "test",
            createdTurn: 1,
            digest: "digest-note",
            reversible: false,
            baselineCommitted: false,
            sessionId,
          };
        },
        evict(sessionId: string) {
          return {
            id: "eviction-1",
            kind: "eviction",
            content: "",
            sourceRefs: [],
            reason: "test",
            createdTurn: 1,
            digest: "digest-eviction",
            reversible: true,
            baselineCommitted: false,
            sessionId,
          };
        },
      },
      events: {
        recordMetricObservation(sessionId: string) {
          return { id: "metric-1", sessionId };
        },
        recordGuardResult(sessionId: string) {
          return { id: "guard-1", sessionId };
        },
      },
      tape: {
        handoff: {
          record(sessionId: string) {
            return { ok: true, eventId: "anchor-1", sessionId };
          },
        },
      },
      reasoning: {
        checkpoints: {
          record(sessionId: string) {
            return { checkpointId: "checkpoint-1", branchId: "branch-1", sessionId };
          },
        },
        reverts: {
          revert(sessionId: string) {
            return { revertId: "revert-1", toCheckpointId: "checkpoint-1", sessionId };
          },
        },
      },
      schedule: {
        intents: {
          create(sessionId: string) {
            return { ok: true, intent: { intentId: "intent-1", sessionId } };
          },
          update(sessionId: string) {
            return { ok: true, intent: { intentId: "intent-1", sessionId } };
          },
          cancel(sessionId: string) {
            return { ok: true, intentId: "intent-1", sessionId };
          },
        },
      },
      session: {
        workerResults: {
          applyMerged(sessionId: string) {
            return { status: "applied", sessionId };
          },
        },
      },
      proposals: {
        proposals: {
          submit(sessionId: string) {
            return { id: "proposal-1", sessionId };
          },
        },
        requests: {
          decide(sessionId: string) {
            return { ok: true, sessionId };
          },
        },
      },
      claim: {
        facts: {
          upsert(sessionId: string) {
            return { ok: true, sessionId };
          },
          resolve(sessionId: string) {
            return { ok: true, sessionId };
          },
        },
      },
      cost: {
        usage: {
          recordAssistant(input: { sessionId: string }) {
            return { ok: true, sessionId: input.sessionId };
          },
        },
      },
      task: {
        spec: {
          set(sessionId: string) {
            return { ok: true, sessionId };
          },
        },
        items: {
          add(sessionId: string) {
            return { ok: true, sessionId };
          },
          update(sessionId: string) {
            return { ok: true, sessionId };
          },
        },
        blockers: {
          record(sessionId: string) {
            return { ok: true, sessionId };
          },
          resolve(sessionId: string) {
            return { ok: true, sessionId };
          },
        },
        acceptance: {
          record(sessionId: string) {
            return { ok: true, sessionId };
          },
        },
      },
      tools: {
        invocation: {
          start(sessionId: string) {
            return { ok: true, sessionId };
          },
          finish(sessionId: string) {
            return { ok: true, sessionId };
          },
          recordResult(input: { sessionId: string }) {
            return { ok: true, sessionId: input.sessionId };
          },
        },
        tracking: {
          markCall(sessionId: string) {
            return { ok: true, sessionId };
          },
          trackCallStart(sessionId: string) {
            return { ok: true, sessionId };
          },
          trackCallEnd(sessionId: string) {
            return { ok: true, sessionId };
          },
        },
        resourceLeases: {
          request(sessionId: string) {
            return { ok: true, sessionId };
          },
          cancel(sessionId: string, leaseId: string) {
            return { ok: true, sessionId, leaseId };
          },
        },
        patches: {
          rollbackLastPatchSet(sessionId: string) {
            return {
              ok: true,
              sessionId,
              restoredPaths: [],
              failedPaths: [],
            };
          },
          rollbackLastMutation(sessionId: string) {
            return { ok: true, sessionId };
          },
        },
      },
      verification: {
        checks: {
          async verify(sessionId: string) {
            return { passed: true, sessionId };
          },
        },
      },
    } as unknown as BrewvaToolRuntime["authority"],
    inspect: {
      tape: {
        status: {
          get(sessionId: string) {
            return {
              sessionId,
              totalEntries: 0,
              entriesSinceAnchor: 0,
              entriesSinceCheckpoint: 0,
              tapePressure: "none",
              thresholds: { low: 80, medium: 160, high: 280 },
            };
          },
          getPressureThresholds() {
            return { low: 80, medium: 160, high: 280 };
          },
        },
        search: {
          search(sessionId: string) {
            return { sessionId, scannedEvents: 0, matches: [] };
          },
        },
      },
      tools: {
        resourceLeases: {
          list(sessionId: string) {
            return [{ id: "lease-1", sessionId }];
          },
        },
      },
      cost: {
        summary: {
          get(sessionId: string) {
            return { sessionId, totals: {} };
          },
        },
      },
    } as unknown as BrewvaToolRuntime["inspect"],
    extensions: {
      tools: {
        resolveCredentialBindings() {
          return { API_TOKEN: "token" };
        },
      },
    },
  };
}

describe("tool runtime capability scope", () => {
  test("keeps the static capability inventory generated from the type-derived capability union", () => {
    const generatorPath = resolve(repoRoot, "script/generate-tool-runtime-capability-inventory.ts");
    const inventoryPath = resolve(
      repoRoot,
      "packages/brewva-tools/src/registry/runtime-capability-inventory.ts",
    );
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };

    expect(existsSync(generatorPath)).toBe(true);
    expect(packageJson.scripts["tools:capability-inventory:check"]).toBe(
      "bun run script/generate-tool-runtime-capability-inventory.ts --check",
    );
    expect(packageJson.scripts.check).toContain("tools:capability-inventory:check");
    expect(readFileSync(inventoryPath, "utf-8")).toContain(
      "Generated by `bun run tools:capability-inventory`",
    );
  });

  test("generator resolves workspace package imports through source exports instead of dist declarations", () => {
    const sourceMappings = collectWorkspaceSourcePathMappings();
    const mappedTargets = Object.values(sourceMappings).flat();

    expect(sourceMappings["@brewva/brewva-runtime"]).toEqual([
      "packages/brewva-runtime/src/index.ts",
    ]);
    expect(sourceMappings["@brewva/brewva-runtime/runtime-extensions"]).toEqual([
      "packages/brewva-runtime/src/runtime/runtime-extensions.ts",
    ]);
    expect(sourceMappings["@brewva/brewva-substrate/tools"]).toEqual([
      "packages/brewva-substrate/src/tools/index.ts",
    ]);
    expect(mappedTargets.filter((target) => target.includes("/dist/"))).toEqual([]);
    expect(collectCapabilityPaths()).toEqual([...BREWVA_TOOL_RUNTIME_CAPABILITY_PATHS]);
  });

  test("static inventory covers every registry-declared capability and excludes operator paths", () => {
    const inventory = new Set(BREWVA_TOOL_RUNTIME_CAPABILITY_PATHS);
    expect([...inventory].filter((capability) => capability.startsWith("operator."))).toEqual([]);

    const missing = Object.entries(TOOL_REQUIRED_CAPABILITIES_BY_NAME).flatMap(
      ([toolName, capabilities]) =>
        capabilities
          .filter((capability) => !inventory.has(capability))
          .map((capability) => `${toolName}:${capability}`),
    );
    expect(missing).toEqual([]);
  });

  test("blocks protected runtime capabilities for undeclared tools", () => {
    const runtime = createToolRuntimeFixture();
    const scoped = createCapabilityScopedToolRuntime(runtime, "grep");

    expect(() => scoped.authority.tools.resourceLeases.request("session-1", {} as never)).toThrow(
      "managed Brewva tool 'grep' attempted to access protected runtime capability 'authority.tools.resourceLeases.request' without declaring it.",
    );
    expect(() => scoped.inspect.tools.resourceLeases.list("session-1", {} as never)).toThrow(
      "managed Brewva tool 'grep' attempted to access protected runtime capability 'inspect.tools.resourceLeases.list' without declaring it.",
    );
    expect(() => scoped.authority.proposals.proposals.submit("session-1", {} as never)).toThrow(
      "managed Brewva tool 'grep' attempted to access protected runtime capability 'authority.proposals.proposals.submit' without declaring it.",
    );
    expect(() => scoped.authority.claim.facts.upsert("session-1", {} as never)).toThrow(
      "managed Brewva tool 'grep' attempted to access protected runtime capability 'authority.claim.facts.upsert' without declaring it.",
    );
    expect(() =>
      scoped.authority.cost.usage.recordAssistant({
        sessionId: "session-1",
      } as never),
    ).toThrow(
      "managed Brewva tool 'grep' attempted to access protected runtime capability 'authority.cost.usage.recordAssistant' without declaring it.",
    );
    expect(() =>
      scoped.authority.tools.invocation.recordResult({
        sessionId: "session-1",
      } as never),
    ).toThrow(
      "managed Brewva tool 'grep' attempted to access protected runtime capability 'authority.tools.invocation.recordResult' without declaring it.",
    );
    expect(() => scoped.inspect.cost.summary.get("session-1")).toThrow(
      "managed Brewva tool 'grep' attempted to access protected runtime capability 'inspect.cost.summary.get' without declaring it.",
    );
    expect(() =>
      scoped.authority?.workbench.note("session-1", {
        content: "note",
        reason: "test",
      }),
    ).toThrow(
      "managed Brewva tool 'grep' attempted to access protected runtime capability 'authority.workbench.note' without declaring it.",
    );
  });

  test("allows only the protected runtime capabilities declared for each tool", () => {
    const runtime = createToolRuntimeFixture();
    const leaseScoped = createCapabilityScopedToolRuntime(runtime, "resource_lease");
    const rollbackScoped = createCapabilityScopedToolRuntime(runtime, "rollback_last_patch");

    const leaseResult = leaseScoped.authority.tools.resourceLeases.request(
      "session-1",
      {} as never,
    );
    expect(leaseResult.ok).toBe(true);

    const listedLeases = leaseScoped.inspect.tools.resourceLeases.list("session-1", {} as never);
    expect(listedLeases).toHaveLength(1);
    expect(listedLeases[0]?.id).toBe("lease-1");
    expect(() => leaseScoped.authority.tools.patches.rollbackLastPatchSet("session-1")).toThrow(
      "managed Brewva tool 'resource_lease' attempted to access protected runtime capability 'authority.tools.patches.rollbackLastPatchSet' without declaring it.",
    );

    const rollbackResult = rollbackScoped.authority.tools.patches.rollbackLastPatchSet("session-1");
    expect(rollbackResult.ok).toBe(true);
    expect(rollbackResult.restoredPaths).toEqual([]);
    expect(rollbackResult.failedPaths).toEqual([]);
    expect(() =>
      rollbackScoped.authority.tools.resourceLeases.request("session-1", {} as never),
    ).toThrow(
      "managed Brewva tool 'rollback_last_patch' attempted to access protected runtime capability 'authority.tools.resourceLeases.request' without declaring it.",
    );
  });

  test("scopes schedule, task, event, and internal capabilities per managed tool", async () => {
    const runtime = createToolRuntimeFixture();
    const scheduleScoped = createCapabilityScopedToolRuntime(runtime, "schedule_intent");
    const taskScoped = createCapabilityScopedToolRuntime(runtime, "task_set_spec");
    const execScoped = createCapabilityScopedToolRuntime(runtime, "exec");
    const workbenchScoped = createCapabilityScopedToolRuntime(runtime, "workbench_note");

    expect(
      (await scheduleScoped.authority.schedule.intents.create("session-1", {} as never)).ok,
    ).toBe(true);
    expect(() => scheduleScoped.authority.task.spec.set("session-1", {} as never)).toThrow(
      "managed Brewva tool 'schedule_intent' attempted to access protected runtime capability 'authority.task.spec.set' without declaring it.",
    );

    expect(() => taskScoped.authority.task.spec.set("session-1", {} as never)).not.toThrow();
    expect(() => taskScoped.authority.schedule.intents.create("session-1", {} as never)).toThrow(
      "managed Brewva tool 'task_set_spec' attempted to access protected runtime capability 'authority.schedule.intents.create' without declaring it.",
    );

    expect(execScoped.extensions?.tools?.resolveCredentialBindings?.("session-1", "exec")).toEqual({
      API_TOKEN: "token",
    });

    const note = workbenchScoped.authority?.workbench.note("session-1", {
      content: "note",
      reason: "test",
    });
    expect(note?.id).toBe("note-1");
    expect(() =>
      workbenchScoped.authority?.workbench.evict("session-1", {
        spanRefs: ["turn:1"],
        reason: "test",
      }),
    ).toThrow(
      "managed Brewva tool 'workbench_note' attempted to access protected runtime capability 'authority.workbench.evict' without declaring it.",
    );
  });

  test("fails closed when declared tool capabilities are outside the static inventory", () => {
    const capabilities = TOOL_REQUIRED_CAPABILITIES_BY_NAME as Record<
      string,
      readonly BrewvaToolRequiredCapability[]
    >;
    capabilities.invalid_inventory_tool = [
      "operator.context.lifecycle.onTurnStart" as BrewvaToolRequiredCapability,
    ];
    try {
      const runtime = {
        get authority() {
          throw new Error("runtime should not be touched");
        },
        get inspect() {
          throw new Error("runtime should not be touched");
        },
      } as unknown as BrewvaToolRuntime;

      expect(() => createCapabilityScopedToolRuntime(runtime, "invalid_inventory_tool")).toThrow(
        "managed Brewva tool 'invalid_inventory_tool' declared unknown runtime capability 'operator.context.lifecycle.onTurnStart'.",
      );
    } finally {
      delete capabilities.invalid_inventory_tool;
    }
  });
});
