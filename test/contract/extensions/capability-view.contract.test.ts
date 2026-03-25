import { describe, expect, test } from "bun:test";
import { buildCapabilityView, renderCapabilityView } from "@brewva/brewva-gateway/runtime-plugins";
import {
  createTaskLedgerTools,
  createExecTool,
  createGrepTool,
  createProcessTool,
  createScheduleIntentTool,
} from "@brewva/brewva-tools";
import { createRuntimeFixture } from "./fixtures/runtime.js";

describe("capability view", () => {
  test("builds semantic inventory with governance-first ordering", () => {
    const result = buildCapabilityView({
      prompt: "continue",
      allTools: [
        {
          name: "exec",
          description: "Run a shell command.",
          parameters: {
            type: "object",
            properties: {
              command: {
                type: "string",
              },
            },
          },
        },
        {
          name: "session_compact",
          description: "Compact session context.",
          parameters: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "tape_search",
          description: "Search tape entries.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
              },
            },
          },
        },
      ],
      activeToolNames: ["exec"],
    });

    expect(result.inventory.availableTotal).toBe(3);
    expect(result.inventory.visibleNames).toEqual(["exec"]);
    expect(result.inventory.visibleByBoundary).toEqual({
      safe: 0,
      effectful: 1,
    });
    expect(result.inventory.hiddenBySurface.skill).toBe(1);
    expect(result.inventory.hiddenBySurface.operator).toBe(0);

    const rendered = renderCapabilityView({
      capabilityView: result,
      mode: "full",
      includeInventory: true,
    });
    expect(rendered[0]?.content).toContain("[CapabilityView]");
    expect(rendered[0]?.content).toContain("available_total: 3");
    expect(rendered[0]?.content).toContain("visible_now: $exec");
    expect(rendered[2]?.content).toContain("hidden_skill_count: 1");
  });

  test("selects capability details from $name requests", () => {
    const result = buildCapabilityView({
      prompt: "inspect $tape_search and $not_exists",
      allTools: [
        {
          name: "tape_search",
          description: "Search tape entries.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
              },
            },
          },
        },
      ],
      activeToolNames: [],
    });

    expect(result.requested).toEqual(["tape_search", "not_exists"]);
    expect(result.details.map((detail) => detail.name)).toEqual(["tape_search"]);
    expect(result.missing).toEqual(["not_exists"]);
    expect(result.details[0]).toMatchObject({
      surface: "skill",
      boundary: "safe",
      visibleNow: false,
    });
    expect(result.details[0]?.effects).toEqual(["runtime_observe"]);

    const rendered = renderCapabilityView({
      capabilityView: result,
      mode: "full",
      includeInventory: false,
    });
    expect(rendered.map((block) => block.id)).toEqual([
      "capability-view-summary",
      "capability-view-policy",
      "capability-detail:tape_search",
      "capability-detail-missing",
    ]);
    expect(rendered[2]?.content).toContain("parameters: query");
    expect(rendered[2]?.content).toContain("surface: skill");
    expect(rendered[3]?.content).toContain("unknown: $not_exists");
  });

  test("returns empty semantic view when tool list is empty", () => {
    const result = buildCapabilityView({
      prompt: "$exec",
      allTools: [],
      activeToolNames: [],
    });

    expect(result.inventory.availableTotal).toBe(0);
    expect(result.requested).toHaveLength(0);
    expect(result.details).toHaveLength(0);
    expect(result.missing).toHaveLength(0);
    expect(renderCapabilityView({ capabilityView: result })).toEqual([]);
  });

  test("does not treat uppercase $NAME tokens as capability requests", () => {
    const result = buildCapabilityView({
      prompt: "env $PATH and $HOME should not expand, but $exec should.",
      allTools: [
        {
          name: "exec",
          description: "Run a shell command.",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
      ],
      activeToolNames: [],
    });

    expect(result.requested).toEqual(["exec"]);
    expect(result.details.map((detail) => detail.name)).toEqual(["exec"]);
    expect(result.missing).toEqual([]);
  });

  test("includes access decisions in detail semantics and rendered output", () => {
    const result = buildCapabilityView({
      prompt: "inspect $exec",
      allTools: [
        {
          name: "exec",
          description: "Run a shell command.",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
      ],
      activeToolNames: [],
      resolveAccess: (toolName) => {
        if (toolName === "exec") {
          return { allowed: false, reason: "blocked-for-test" };
        }
        return { allowed: true };
      },
    });

    expect(result.details[0]?.access).toEqual({
      allowed: false,
      reason: "blocked-for-test",
    });
    const rendered = renderCapabilityView({
      capabilityView: result,
      mode: "compact",
      includeInventory: false,
    });
    expect(rendered[2]?.content).toContain("allowed_now: false");
    expect(rendered[2]?.content).toContain("deny_reason: blocked-for-test");
  });

  test("renders enum contract details for requested capabilities", () => {
    const runtime = createRuntimeFixture();
    const grepTool = createGrepTool({ runtime });
    const result = buildCapabilityView({
      prompt: "inspect $grep",
      allTools: [grepTool],
      activeToolNames: [],
    });

    expect(result.details[0]?.parameterDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pathText: "case",
          acceptedValues: ["smart", "insensitive", "sensitive"],
        }),
      ]),
    );

    const rendered = renderCapabilityView({
      capabilityView: result,
      mode: "full",
      includeInventory: false,
    });
    expect(rendered[2]?.content).toContain("param.case:");
    expect(rendered[2]?.content).toContain("values=smart|insensitive|sensitive");
    expect(rendered[2]?.content).toContain("aliases=case-insensitive->insensitive");
  });

  test("renders nested enum contract details for schedule intent predicates", () => {
    const runtime = createRuntimeFixture();
    const scheduleIntentTool = createScheduleIntentTool({ runtime });
    const result = buildCapabilityView({
      prompt: "inspect $schedule_intent",
      allTools: [scheduleIntentTool],
      activeToolNames: [],
    });

    expect(result.details[0]?.parameterDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pathText: "action",
          acceptedValues: ["create", "update", "cancel", "list"],
        }),
        expect.objectContaining({
          pathText: "convergenceCondition.kind",
          acceptedValues: ["truth_resolved", "task_phase", "max_runs", "all_of", "any_of"],
        }),
        expect.objectContaining({
          pathText: "convergenceCondition.phase",
          acceptedValues: [
            "align",
            "investigate",
            "execute",
            "verify",
            "ready_for_acceptance",
            "blocked",
            "done",
          ],
        }),
      ]),
    );

    const rendered = renderCapabilityView({
      capabilityView: result,
      mode: "full",
      includeInventory: false,
    });
    expect(rendered[2]?.content).toContain("param.action:");
    expect(rendered[2]?.content).toContain("param.convergenceCondition.kind:");
    expect(rendered[2]?.content).toContain(
      "values=truth_resolved|task_phase|max_runs|all_of|any_of",
    );
  });

  test("records operator visibility hints in inventory semantics", () => {
    const result = buildCapabilityView({
      prompt: "continue",
      allTools: [
        {
          name: "skill_load",
          description: "Load a skill.",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "obs_query",
          description: "Query runtime events.",
          parameters: { type: "object", properties: {} },
        },
      ],
      activeToolNames: ["skill_load"],
    });

    expect(result.inventory.hiddenBySurface.operator).toBe(1);
    expect(result.inventory.hints).toContain("operator_profile_available");
    expect(
      renderCapabilityView({
        capabilityView: result,
        mode: "full",
        includeInventory: true,
      })[2]?.content.includes("operator_hint: operator/full profile keeps these tools visible"),
    ).toBe(true);
  });

  test("marks operator acceptance closure as non-rollbackable", () => {
    const runtime = createRuntimeFixture();
    const acceptanceTool = createTaskLedgerTools({ runtime }).find(
      (tool) => tool.name === "task_record_acceptance",
    );
    expect(acceptanceTool).toBeDefined();
    if (!acceptanceTool) return;

    const result = buildCapabilityView({
      prompt: "inspect $task_record_acceptance",
      allTools: [acceptanceTool],
      activeToolNames: [],
    });

    expect(result.details[0]).toMatchObject({
      name: "task_record_acceptance",
      rollbackable: false,
      requiresApproval: false,
      boundary: "effectful",
    });
  });

  test("records skill visibility hints when no skill-scoped tool is active", () => {
    const result = buildCapabilityView({
      prompt: "continue",
      allTools: [
        {
          name: "session_compact",
          description: "Compact session context.",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "tape_search",
          description: "Search tape entries.",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      ],
      activeToolNames: ["session_compact"],
    });

    expect(result.inventory.hiddenBySurface.skill).toBe(1);
    expect(result.inventory.hints).toContain("load_or_accept_skill");
  });

  test("captures effect boundaries and rollback hints for mutable tools", () => {
    const result = buildCapabilityView({
      prompt: "inspect $task_set_spec",
      allTools: [
        {
          name: "task_set_spec",
          description: "Set the task specification.",
          parameters: { type: "object", properties: { goal: { type: "string" } } },
        },
      ],
      activeToolNames: [],
    });

    expect(result.details[0]?.boundary).toBe("effectful");
    expect(result.details[0]?.rollbackable).toBe(true);
    expect(result.details[0]?.effects).toEqual(["memory_write"]);
  });

  test("renders compact disclosure without inventory noise", () => {
    const result = buildCapabilityView({
      prompt: "inspect $task_set_spec",
      allTools: [
        {
          name: "session_compact",
          description: "Compact session context.",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "task_set_spec",
          description: "Set the task specification.",
          parameters: { type: "object", properties: { goal: { type: "string" } } },
        },
        {
          name: "obs_query",
          description: "Query runtime events.",
          parameters: { type: "object", properties: {} },
        },
      ],
      activeToolNames: ["session_compact"],
    });

    const rendered = renderCapabilityView({
      capabilityView: result,
      mode: "compact",
      includeInventory: false,
    });

    expect(rendered.map((block) => block.id)).toEqual([
      "capability-view-summary",
      "capability-view-policy",
      "capability-detail:task_set_spec",
    ]);
    expect(rendered[1]?.content).toContain("boundary_policy:");
    expect(rendered[1]?.content).not.toContain("surface_policy:");
    expect(rendered[2]?.content).toContain("boundary: effectful");
    expect(rendered[2]?.content).not.toContain("description:");
  });

  test("uses canonical parameter keys for managed tools that keep explicit alias fields", () => {
    const result = buildCapabilityView({
      prompt: "inspect $exec and $process",
      allTools: [createExecTool(), createProcessTool()],
      activeToolNames: [],
    });

    expect(result.details).toHaveLength(2);
    expect(result.details[0]).toMatchObject({
      name: "exec",
      parameterKeys: ["background", "command", "env", "timeout", "workdir", "yieldMs"],
    });
    expect(result.details[1]).toMatchObject({
      name: "process",
      parameterKeys: ["action", "data", "eof", "limit", "offset", "sessionId", "timeout"],
    });
  });
});
