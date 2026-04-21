import { describe, expect, test } from "bun:test";
import type {
  BrewvaHostedRuntimePort,
  SkillCompletionFailureRecord,
  SkillDocument,
} from "@brewva/brewva-runtime";
import type { BrewvaHostContext, InternalHostPluginApi } from "@brewva/brewva-substrate";
import { createCompletionGuardLifecycle } from "../../../packages/brewva-gateway/src/runtime-plugins/completion-guard.js";

function createSkillDocument(): SkillDocument {
  return {
    name: "repository-analysis",
    description: "Analyze repository state.",
    category: "core",
    markdown: "",
    filePath: "/tmp/repository-analysis/SKILL.md",
    baseDir: "/tmp/repository-analysis",
    contract: {
      effectLevel: "read_only",
      allowedEffects: ["workspace_read", "runtime_observe"],
      deniedEffects: [],
      preferredTools: ["grep"],
      fallbackTools: ["skill_complete"],
      requiredInputs: [],
      optionalInputs: [],
      requiredOutputs: ["repository_snapshot"],
      outputContracts: ["repository_snapshot"],
      readiness: "available",
      routingScope: "core",
      costHint: "medium",
      defaultLease: {},
      hardCeiling: {},
      resources: {
        references: [],
        scripts: [],
        heuristics: [],
        invariants: [],
      },
    },
  } as unknown as SkillDocument;
}

function createLifecycleHarness() {
  const sentMessages: Array<{
    message: Parameters<InternalHostPluginApi["sendMessage"]>[0];
    options: Parameters<InternalHostPluginApi["sendMessage"]>[1];
  }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const skill = createSkillDocument();
  const runtime = {
    inspect: {
      skills: {
        getActive: () => skill,
        getActiveState: () => ({ phase: "active" }),
        getLatestFailure: () => undefined,
      },
    },
  } as unknown as BrewvaHostedRuntimePort;
  const extensionApi = {
    sendMessage(
      message: Parameters<InternalHostPluginApi["sendMessage"]>[0],
      options: Parameters<InternalHostPluginApi["sendMessage"]>[1],
    ) {
      sentMessages.push({ message, options });
    },
  } as unknown as InternalHostPluginApi;
  const ctx = {
    sessionManager: {
      getSessionId: () => "completion-guard-session",
    },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  } as unknown as BrewvaHostContext;

  return {
    lifecycle: createCompletionGuardLifecycle(extensionApi, runtime),
    sentMessages,
    notifications,
    ctx,
  };
}

function createFailedContractHarness() {
  const sentMessages: Array<{
    message: Parameters<InternalHostPluginApi["sendMessage"]>[0];
    options: Parameters<InternalHostPluginApi["sendMessage"]>[1];
  }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const failure = {
    skillName: "repository-analysis",
    phase: "failed_contract",
    missing: ["repository_snapshot", "impact_map"],
    invalid: [],
    repairGuidance: {
      unresolvedFields: [],
      minimumContractState: "Provide every required output with non-empty values.",
    },
  } as unknown as SkillCompletionFailureRecord;
  const runtime = {
    inspect: {
      skills: {
        getActive: () => undefined,
        getActiveState: () => undefined,
        getLatestFailure: () => failure,
        list: () => [createSkillDocument()],
        getLoadReport: () => ({
          loadedSkills: ["repository-analysis"],
          routingEnabled: true,
          routingScopes: ["core"],
          routableSkills: ["repository-analysis"],
          hiddenSkills: [],
        }),
      },
      task: {
        getState: () => ({
          spec: {
            schema: "brewva.task.v1",
            goal: "Analyze this repository before changing code.",
          },
          status: { phase: "investigate" },
          items: [],
          blockers: [],
        }),
      },
    },
  } as unknown as BrewvaHostedRuntimePort;
  const extensionApi = {
    sendMessage(
      message: Parameters<InternalHostPluginApi["sendMessage"]>[0],
      options: Parameters<InternalHostPluginApi["sendMessage"]>[1],
    ) {
      sentMessages.push({ message, options });
    },
  } as unknown as InternalHostPluginApi;
  const ctx = {
    sessionManager: {
      getSessionId: () => "completion-guard-failed-contract-session",
    },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  } as unknown as BrewvaHostContext;

  return {
    lifecycle: createCompletionGuardLifecycle(extensionApi, runtime),
    sentMessages,
    notifications,
    ctx,
  };
}

function createSkillFirstHarness() {
  const sentMessages: Array<{
    message: Parameters<InternalHostPluginApi["sendMessage"]>[0];
    options: Parameters<InternalHostPluginApi["sendMessage"]>[1];
  }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const skill = createSkillDocument();
  const runtime = {
    inspect: {
      skills: {
        getActive: () => undefined,
        getActiveState: () => undefined,
        getLatestFailure: () => undefined,
        list: () => [
          {
            ...skill,
            description: "Build a reliable repository snapshot, impact map, and planning posture.",
            contract: {
              ...skill.contract,
              routing: { scope: "core" },
              selection: {
                whenToUse:
                  "Use when the task needs repository orientation, impact analysis, or boundary mapping before design, debugging, review, or execution.",
                examples: ["Analyze this repository before changing code."],
                phases: ["investigate"],
              },
            },
          },
        ],
        getLoadReport: () => ({
          loadedSkills: ["repository-analysis"],
          routingEnabled: true,
          routingScopes: ["core"],
          routableSkills: ["repository-analysis"],
          hiddenSkills: [],
        }),
      },
      task: {
        getState: () => ({
          spec: {
            schema: "brewva.task.v1",
            goal: "The task needs repository orientation, impact analysis, and boundary mapping before design or execution.",
            expectedBehavior: "Produce a repository-aware assessment with path-grounded evidence.",
            constraints: ["Read-only investigation", "Do not answer from memory alone"],
          },
          status: { phase: "investigate" },
          items: [],
          blockers: [],
        }),
      },
    },
  } as unknown as BrewvaHostedRuntimePort;
  const extensionApi = {
    sendMessage(
      message: Parameters<InternalHostPluginApi["sendMessage"]>[0],
      options: Parameters<InternalHostPluginApi["sendMessage"]>[1],
    ) {
      sentMessages.push({ message, options });
    },
  } as unknown as InternalHostPluginApi;
  const ctx = {
    sessionManager: {
      getSessionId: () => "completion-guard-skill-first-session",
    },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  } as unknown as BrewvaHostContext;

  return {
    lifecycle: createCompletionGuardLifecycle(extensionApi, runtime),
    sentMessages,
    notifications,
    ctx,
  };
}

function createRequiredSkillFirstHarness() {
  const sentMessages: Array<{
    message: Parameters<InternalHostPluginApi["sendMessage"]>[0];
    options: Parameters<InternalHostPluginApi["sendMessage"]>[1];
  }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const skill = createSkillDocument();
  const runtime = {
    inspect: {
      skills: {
        getActive: () => undefined,
        getActiveState: () => undefined,
        getLatestFailure: () => undefined,
        list: () => [
          {
            ...skill,
            description: "Build a reliable repository snapshot, impact map, and planning posture.",
            contract: {
              ...skill.contract,
              routing: { scope: "core" },
              selection: {
                whenToUse:
                  "Use when the task needs repository orientation, impact analysis, or boundary mapping before design, debugging, review, or execution.",
                examples: ["Analyze this repository before changing code."],
                phases: ["execute"],
              },
            },
          },
        ],
        getLoadReport: () => ({
          loadedSkills: ["repository-analysis"],
          routingEnabled: true,
          routingScopes: ["core"],
          routableSkills: ["repository-analysis"],
          hiddenSkills: [],
        }),
      },
      task: {
        getState: () => ({
          spec: {
            schema: "brewva.task.v1",
            goal: "Execute the implementation after repository orientation and impact analysis.",
            expectedBehavior: "Use the repository-analysis workflow before execution.",
            constraints: ["Execution phase requires explicit skill activation"],
          },
          status: { phase: "execute" },
          items: [],
          blockers: [],
        }),
      },
    },
  } as unknown as BrewvaHostedRuntimePort;
  const extensionApi = {
    sendMessage(
      message: Parameters<InternalHostPluginApi["sendMessage"]>[0],
      options: Parameters<InternalHostPluginApi["sendMessage"]>[1],
    ) {
      sentMessages.push({ message, options });
    },
  } as unknown as InternalHostPluginApi;
  const ctx = {
    sessionManager: {
      getSessionId: () => "completion-guard-required-skill-first-session",
    },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  } as unknown as BrewvaHostContext;

  return {
    lifecycle: createCompletionGuardLifecycle(extensionApi, runtime),
    sentMessages,
    notifications,
    ctx,
  };
}

describe("completion guard lifecycle", () => {
  test("queues a follow-up before agent_end when a terminal assistant turn leaves an active skill open", () => {
    const { lifecycle, sentMessages, ctx } = createLifecycleHarness();

    lifecycle.turnEnd(
      {
        type: "turn_end",
        turnIndex: 1,
        message: {
          role: "assistant",
          stopReason: "stop",
        },
        toolResults: [],
      },
      ctx,
    );

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.message.customType).toBe("brewva-guard");
    expect(sentMessages[0]?.options).toEqual({
      deliverAs: "followUp",
      triggerTurn: true,
    });
  });

  test("keeps terminal assistant prose visible while an active skill is unfinished", () => {
    const { lifecycle, ctx } = createLifecycleHarness();

    const result = lifecycle.messageEnd(
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "This is only a draft." }],
        },
      },
      ctx,
    );

    expect(result).toBeUndefined();
  });

  test("does not queue a guard follow-up for tool-result turns", () => {
    const { lifecycle, sentMessages, ctx } = createLifecycleHarness();

    lifecycle.turnEnd(
      {
        type: "turn_end",
        turnIndex: 1,
        message: {
          role: "assistant",
          stopReason: "toolUse",
        },
        toolResults: [
          {
            role: "toolResult",
            toolName: "grep",
          },
        ],
      },
      ctx,
    );

    expect(sentMessages).toEqual([]);
  });

  test("emits a visible skill-load recommendation notice for advisory routed skills", () => {
    const { lifecycle, sentMessages, ctx } = createSkillFirstHarness();

    lifecycle.beforeAgentStart(
      {
        type: "before_agent_start",
        prompt:
          "Assess Brewva architecture with repository orientation, impact analysis, and boundary mapping before design or execution.",
        parts: [],
        systemPrompt: "",
      },
      ctx,
    );
    lifecycle.turnEnd(
      {
        type: "turn_end",
        turnIndex: 1,
        message: {
          role: "assistant",
          stopReason: "stop",
        },
        toolResults: [],
      },
      ctx,
    );

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.message.customType).toBe("brewva-guard");
    expect(String(sentMessages[0]?.message.content)).toContain("Consider tool `skill_load`");
    expect(String(sentMessages[0]?.message.content)).toContain("repository-analysis");
    expect(sentMessages[0]?.options).toEqual({
      triggerTurn: false,
    });
  });

  test("does not re-open a skill-load obligation after skill_complete fulfilled the current prompt", () => {
    const { lifecycle, sentMessages, ctx } = createRequiredSkillFirstHarness();

    lifecycle.beforeAgentStart(
      {
        type: "before_agent_start",
        prompt: "Execute the implementation after using the repository-analysis workflow.",
        parts: [],
        systemPrompt: "",
      },
      ctx,
    );
    lifecycle.toolResult(
      {
        type: "tool_result",
        toolCallId: "tc-skill-complete",
        toolName: "skill_complete",
        input: {},
        content: [{ type: "text", text: "Skill completed." }],
        isError: false,
      },
      ctx,
    );
    lifecycle.turnEnd(
      {
        type: "turn_end",
        turnIndex: 2,
        message: {
          role: "assistant",
          stopReason: "stop",
        },
        toolResults: [],
      },
      ctx,
    );

    expect(sentMessages).toEqual([]);
  });

  test("does not start another repair turn after a skill contract has failed permanently", () => {
    const { lifecycle, sentMessages, ctx } = createFailedContractHarness();

    const result = lifecycle.messageEnd(
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Another summary that should be hidden." }],
        },
      },
      ctx,
    );
    lifecycle.turnEnd(
      {
        type: "turn_end",
        turnIndex: 3,
        message: {
          role: "assistant",
          stopReason: "stop",
        },
        toolResults: [],
      },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.message.customType).toBe("brewva-guard");
    expect(String(sentMessages[0]?.message.content)).toContain("Skill contract failed");
    expect(sentMessages[0]?.options).toEqual({
      triggerTurn: false,
    });
  });
});
