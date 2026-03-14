import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerDebugLoop } from "@brewva/brewva-gateway/runtime-plugins";
import {
  BrewvaRuntime,
  DEFAULT_BREWVA_CONFIG,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  type BrewvaStructuredEvent,
  type ProposalRecord,
} from "@brewva/brewva-runtime";
import { createSkillCompleteTool, createSkillLoadTool } from "@brewva/brewva-tools";
import { createMockExtensionAPI, invokeHandlers } from "../helpers/extension.js";
import { createTestWorkspace, writeTestConfig } from "../helpers/workspace.js";

type ToolExecutionContext = Parameters<ReturnType<typeof createSkillLoadTool>["execute"]>[4];

function repoRoot(): string {
  return process.cwd();
}

export function createSkillWorkspace(name: string): string {
  const workspace = createTestWorkspace(name);
  writeTestConfig(workspace, structuredClone(DEFAULT_BREWVA_CONFIG));
  symlinkSync(
    join(repoRoot(), "skills"),
    join(workspace, "skills"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return workspace;
}

export function artifactPath(workspace: string, sessionId: string, fileName: string): string {
  const encoded = Buffer.from(sessionId, "utf8").toString("base64url");
  return join(workspace, ".orchestrator/artifacts/sessions", `sess_${encoded}`, fileName);
}

export function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function extractTextContent(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const textPart = result.content.find(
    (item) => item.type === "text" && typeof item.text === "string",
  );
  return textPart?.text ?? "";
}

export function createContext(
  sessionId: string,
  workspace: string,
  leafId?: string,
): {
  cwd: string;
  sessionManager: { getSessionId(): string; getLeafId(): string | undefined };
} {
  return {
    cwd: workspace,
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
      getLeafId() {
        return leafId;
      },
    },
  };
}

export function toToolContext(ctx: ReturnType<typeof createContext>): ToolExecutionContext {
  return ctx as ToolExecutionContext;
}

export async function waitFor<T>(
  probe: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 1_500;
  const intervalMs = options.intervalMs ?? 10;
  const startedAt = Date.now();
  let lastValue: T | undefined;

  while (Date.now() - startedAt <= timeoutMs) {
    lastValue = await probe();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    options.label ?? "Timed out while waiting for asynchronous debug-loop side effects.",
  );
}

export type DebugLoopFixture = {
  workspace: string;
  runtime: BrewvaRuntime;
  handlers: ReturnType<typeof createMockExtensionAPI>["handlers"];
  ctx: ReturnType<typeof createContext>;
  toolCtx: ToolExecutionContext;
  loadTool: ReturnType<typeof createSkillLoadTool>;
  completeTool: ReturnType<typeof createSkillCompleteTool>;
  emitRuntimeEvent(event: BrewvaStructuredEvent): void;
};

export function createDebugLoopFixture(
  workspaceName: string,
  sessionId: string,
  leafId: string,
): DebugLoopFixture {
  const workspace = createSkillWorkspace(workspaceName);
  const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
  const listeners: Array<(event: BrewvaStructuredEvent) => void> = [];
  const originalSubscribe = runtime.events.subscribe.bind(runtime.events);
  (
    runtime.events as unknown as {
      subscribe(listener: (event: BrewvaStructuredEvent) => void): () => void;
    }
  ).subscribe = (listener) => {
    listeners.push(listener);
    return originalSubscribe(listener);
  };

  try {
    const { api, handlers } = createMockExtensionAPI();
    registerDebugLoop(api, runtime);
    const ctx = createContext(sessionId, workspace, leafId);
    const toolCtx = toToolContext(ctx);
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    return {
      workspace,
      runtime,
      handlers,
      ctx,
      toolCtx,
      loadTool,
      completeTool,
      emitRuntimeEvent(event) {
        for (const listener of listeners) {
          listener(event);
        }
      },
    };
  } finally {
    (
      runtime.events as unknown as {
        subscribe(listener: (event: BrewvaStructuredEvent) => void): () => void;
      }
    ).subscribe = originalSubscribe;
  }
}

export async function scheduleInitialRetry(
  fixture: DebugLoopFixture,
  outputs: Record<string, unknown> = {
    change_set: "updated one line",
    files_changed: ["src/example.ts"],
    verification_evidence: ["pending verification"],
  },
): Promise<string> {
  const sessionId = fixture.ctx.sessionManager.getSessionId();
  await fixture.loadTool.execute(
    "tc-load",
    { name: "implementation" },
    undefined,
    undefined,
    fixture.toolCtx,
  );
  fixture.runtime.tools.markCall(sessionId, "edit");
  invokeHandlers(
    fixture.handlers,
    "tool_call",
    {
      toolCallId: "tc-complete",
      toolName: "skill_complete",
      input: { outputs },
    },
    fixture.ctx,
  );

  const result = await fixture.completeTool.execute(
    "tc-complete",
    { outputs },
    undefined,
    undefined,
    fixture.toolCtx,
  );
  await waitFor(
    () =>
      fixture.runtime.proposals.list(sessionId, {
        kind: "context_packet",
        limit: 1,
      })[0] as ProposalRecord<"context_packet"> | undefined,
    (record) => record?.proposal.payload.packetKey === "debug-loop:status",
    {
      label: "Timed out while waiting for debug-loop status packet.",
    },
  );
  return extractTextContent(result as { content: Array<{ type: string; text?: string }> });
}

export function recordImplementationFailure(
  runtime: BrewvaRuntime,
  sessionId: string,
  timestamp: number,
): void {
  runtime.skills.activate(sessionId, "implementation");
  runtime.events.record({
    sessionId,
    type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
    timestamp,
    payload: {
      outcome: "fail",
      activeSkill: "implementation",
      failedChecks: ["tests_failed"],
      missingEvidence: [],
      rootCause: "missing branch handling",
      recommendation: "add branch coverage",
      commandsExecuted: [],
      evidenceIds: [`evidence-${timestamp}`],
      evidence: [],
    },
  });
}

export function blockArtifactSessionsRoot(workspace: string): void {
  mkdirSync(join(workspace, ".orchestrator", "artifacts"), { recursive: true });
  writeFileSync(join(workspace, ".orchestrator", "artifacts", "sessions"), "blocked", "utf8");
}
