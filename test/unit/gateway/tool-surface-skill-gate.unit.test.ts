import { describe, expect, test } from "bun:test";
import type { BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import {
  createToolSurfaceLifecycle,
  type ToolSurfaceRuntime,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/tools/tool-surface.js";

// The skill-surface pull gate (tool-surface subtraction RFC, Step 4): base tools
// are always-on; skill-surface tools enter the per-turn payload only when the
// turn explicitly requests them ($name) or a selected capability authorizes
// them. This pins the documented policy AS IMPLEMENTED — the pre-RFC drift was
// that every skill tool shipped in every turn's payload (tape activeCount
// 91-94) while the capability view claimed commitment gating.

function toolDefinition(name: string): BrewvaToolDefinition {
  return {
    name,
    description: `${name} test definition`,
    parameters: { type: "object", properties: {} },
  } as unknown as BrewvaToolDefinition;
}

interface FakeExtensionApi {
  registered: string[];
  active: string[];
  setActiveCalls: string[][];
  getAllTools(): Array<{ name: string }>;
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
  registerTool(definition: BrewvaToolDefinition): void;
}

function createFakeExtensionApi(initialHostTools: string[]): FakeExtensionApi {
  const api: FakeExtensionApi = {
    registered: [...initialHostTools],
    active: [...initialHostTools],
    setActiveCalls: [],
    getAllTools() {
      return api.registered.map((name) => ({ name }));
    },
    getActiveTools() {
      return api.active;
    },
    setActiveTools(toolNames: string[]) {
      api.setActiveCalls.push([...toolNames]);
      api.active = [...toolNames];
    },
    registerTool(definition: BrewvaToolDefinition) {
      api.registered.push(definition.name);
    },
  };
  return api;
}

function createFakeRuntime(): ToolSurfaceRuntime {
  const capabilityReceipts = new Map<string, object>();
  const surfacePayloads: object[] = [];
  return {
    identity: { cwd: process.cwd(), workspaceRoot: process.cwd() },
    config: {
      capabilities: {
        roots: [],
        defaults: {},
        policy: { agentScope: [], workspaceScope: [], allowedAccounts: [] },
      },
    },
    ops: {
      skills: {
        selection: {
          latest: () => undefined,
        },
      },
      tools: {
        capabilitySelection: {
          latest: (sessionId: string) => capabilityReceipts.get(sessionId),
          record: (sessionId: string, receipt: object) => {
            capabilityReceipts.set(sessionId, receipt);
            return receipt;
          },
        },
        surface: {
          recordResolved: (_sessionId: string, payload: object) => {
            surfacePayloads.push(payload);
            return payload;
          },
        },
      },
      goal: {
        state: {
          get: () => null,
        },
      },
    },
  };
}

function makeContext(sessionId: string): object {
  return {
    hasUI: false,
    sessionManager: {
      getSessionId: () => sessionId,
    },
  };
}

describe("tool-surface skill gate (pull, not push)", () => {
  test("skill tools stay out of the default payload, surface for one $name turn, then drop again", () => {
    const extensionApi = createFakeExtensionApi(["read", "edit"]);
    const runtime = createFakeRuntime();
    const definitions = new Map<string, BrewvaToolDefinition>([
      ["grep", toolDefinition("grep")],
      ["recall_search", toolDefinition("recall_search")],
      ["attention_pin", toolDefinition("attention_pin")],
    ]);
    const lifecycle = createToolSurfaceLifecycle(
      extensionApi as unknown as Parameters<typeof createToolSurfaceLifecycle>[0],
      runtime,
      { dynamicToolDefinitions: definitions },
    );
    const ctx = makeContext("sess_gate");

    // Turn 1: no explicit request — base surfaces, skill stays hidden.
    lifecycle.beforeAgentStart({ prompt: "look around the repo" }, ctx);
    const turn1 = extensionApi.setActiveCalls.at(-1) ?? [];
    expect(turn1).toContain("grep");
    expect(turn1).toContain("read");
    expect(turn1).not.toContain("recall_search");
    expect(turn1).not.toContain("attention_pin");

    // Turn 2: explicit $name request pulls exactly the requested skill tool in.
    lifecycle.beforeAgentStart({ prompt: "please use $recall_search for this" }, ctx);
    const turn2 = extensionApi.setActiveCalls.at(-1) ?? [];
    expect(turn2).toContain("recall_search");
    expect(turn2).not.toContain("attention_pin");

    // Turn 3: no request again — the pulled tool drops back out (one-turn
    // surfacing), even though its definition stays registered with the host.
    lifecycle.beforeAgentStart({ prompt: "carry on" }, ctx);
    const turn3 = extensionApi.setActiveCalls.at(-1) ?? [];
    expect(turn3).not.toContain("recall_search");
    expect(extensionApi.registered).toContain("recall_search");
    expect(turn3).toContain("grep");
  });
});
