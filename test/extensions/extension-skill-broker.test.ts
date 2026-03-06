import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerContextTransform } from "@brewva/brewva-extensions";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createSkillBrokerExtension, type SkillBroker } from "@brewva/brewva-skill-broker";
import { createMockExtensionAPI } from "../helpers/extension.js";
import { createTestWorkspace } from "../helpers/workspace.js";

function repoRoot(): string {
  return process.cwd();
}

function writeCatalog(
  workspace: string,
  input: {
    skills: Array<{
      name: string;
      description: string;
      outputs?: string[];
      consumes?: string[];
      toolsRequired?: string[];
    }>;
  },
): void {
  const brewvaDir = join(workspace, ".brewva");
  mkdirSync(brewvaDir, { recursive: true });
  writeFileSync(
    join(brewvaDir, "skills_index.json"),
    JSON.stringify(
      {
        generatedAt: "2026-03-06T00:00:00.000Z",
        skills: input.skills.map((entry) => ({
          name: entry.name,
          tier: "pack",
          description: entry.description,
          outputs: entry.outputs ?? [],
          toolsRequired: entry.toolsRequired ?? ["read"],
          costHint: "medium",
          stability: "stable",
          composableWith: [],
          consumes: entry.consumes ?? [],
          dispatch: {
            gateThreshold: 10,
            autoThreshold: 16,
            defaultMode: "suggest",
          },
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function readLatestBrokerTrace(
  workspace: string,
  sessionId: string,
): { judge?: { status?: string; reason?: string } } {
  const traceDir = join(workspace, ".brewva", "skill-broker", sessionId);
  const traceFiles = readdirSync(traceDir).filter((entry) => entry.endsWith(".json"));
  const latestTrace = traceFiles.toSorted().at(-1);
  if (!latestTrace) {
    throw new Error("Expected broker trace file.");
  }
  return JSON.parse(readFileSync(join(traceDir, latestTrace), "utf8")) as {
    judge?: { status?: string; reason?: string };
  };
}

describe("external skill broker extension", () => {
  test("injects external preselection before context transform routing", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "skill-broker-ext";

    await createSkillBrokerExtension({ runtime })(api);
    registerContextTransform(api, runtime);

    const beforeHandlers = handlers.get("before_agent_start") ?? [];
    expect(beforeHandlers).toHaveLength(2);

    let result: unknown;
    for (const handler of beforeHandlers) {
      result = await handler(
        {
          type: "before_agent_start",
          prompt: "Review architecture risks, merge safety, and quality audit gaps",
          systemPrompt: "base",
        },
        {
          sessionManager: {
            getSessionId: () => sessionId,
          },
          getContextUsage: () => undefined,
        },
      );
    }

    const trace = runtime.skills.getLastRouting(sessionId);
    expect(trace?.source).toBe("external_preselection");
    expect(trace?.selection.reason).toBe("external_preselection_selected");
    expect(trace?.selection.selectedSkills).toContain("review");
    expect(
      (result as { message?: { details?: { routingSelection?: { reason?: string } } } }).message
        ?.details?.routingSelection?.reason,
    ).toBe("external_preselection_selected");
  });

  test("forwards current model and model registry to broker judge context", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    let seenModel: string | null = null;
    let seenModelRegistry = false;

    const broker: SkillBroker = {
      async select(input) {
        const model = input.judgeContext?.model;
        seenModel = model ? `${model.provider}/${model.id}` : null;
        seenModelRegistry = !!input.judgeContext?.modelRegistry;
        return {
          selected: [],
          routingOutcome: "empty",
          trace: {
            brokerVersion: "test",
            prompt: input.prompt,
            promptHash: "hash",
            catalogPath: "/tmp/catalog.json",
            routingOutcome: "empty",
            reason: "test",
            selected: [],
            shortlisted: [],
          },
        };
      },
    };

    await createSkillBrokerExtension({ runtime, broker })(api);

    const beforeHandlers = handlers.get("before_agent_start") ?? [];
    expect(beforeHandlers).toHaveLength(1);

    await beforeHandlers[0]?.(
      {
        type: "before_agent_start",
        prompt: "route this request",
        systemPrompt: "base",
      },
      {
        sessionManager: {
          getSessionId: () => "skill-broker-model-context",
        },
        model: {
          provider: "openai",
          id: "gpt-5.3-codex",
        },
        modelRegistry: {
          async getApiKey() {
            return "test-key";
          },
        },
      },
    );

    expect(String(seenModel)).toBe("openai/gpt-5.3-codex");
    expect(seenModelRegistry).toBe(true);
  });

  test("uses preview-only broker path when brokerJudgeMode is heuristic", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const workspace = createTestWorkspace("skill-broker-heuristic");
    writeCatalog(workspace, {
      skills: [
        {
          name: "review",
          description: "Review architecture risks and merge safety.",
          outputs: ["findings"],
        },
      ],
    });
    const runtime = new BrewvaRuntime({ cwd: workspace });
    runtime.config.skills.selector.brokerJudgeMode = "heuristic";
    const sessionId = "heuristic-session";

    await createSkillBrokerExtension({ runtime })(api);

    const beforeHandlers = handlers.get("before_agent_start") ?? [];
    expect(beforeHandlers).toHaveLength(1);

    await beforeHandlers[0]?.(
      {
        type: "before_agent_start",
        prompt: "review architecture risks and merge safety",
        systemPrompt: "base",
      },
      {
        sessionManager: {
          getSessionId: () => sessionId,
        },
        model: {
          provider: "openai",
          id: "gpt-5.3-codex",
        },
        modelRegistry: {
          async getApiKey() {
            return "test-key";
          },
        },
      },
    );

    const trace = readLatestBrokerTrace(workspace, sessionId);
    expect(trace.judge).toBeUndefined();
  });

  test("records judge trace when brokerJudgeMode is llm", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const workspace = createTestWorkspace("skill-broker-llm");
    writeCatalog(workspace, {
      skills: [
        {
          name: "review",
          description: "Review architecture risks and merge safety.",
          outputs: ["findings"],
        },
      ],
    });
    const runtime = new BrewvaRuntime({ cwd: workspace });
    runtime.config.skills.selector.brokerJudgeMode = "llm";
    const sessionId = "llm-session";

    await createSkillBrokerExtension({ runtime })(api);

    const beforeHandlers = handlers.get("before_agent_start") ?? [];
    expect(beforeHandlers).toHaveLength(1);

    await beforeHandlers[0]?.(
      {
        type: "before_agent_start",
        prompt: "review architecture risks and merge safety",
        systemPrompt: "base",
      },
      {
        sessionManager: {
          getSessionId: () => sessionId,
        },
      },
    );

    const trace = readLatestBrokerTrace(workspace, sessionId);
    expect(trace.judge?.status).toBe("skipped");
    expect(trace.judge?.reason).toBe("no_model");
  });
});
