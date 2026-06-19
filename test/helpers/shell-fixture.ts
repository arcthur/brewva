import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context as ProviderContext } from "@brewva/brewva-provider-core/contracts";
import type { BrewvaToolUiPort } from "@brewva/brewva-substrate/host-api";
import {
  buildBrewvaPromptText,
  type BrewvaPromptContentPart,
} from "@brewva/brewva-substrate/prompt";
import type { BrewvaRegisteredModel } from "@brewva/brewva-substrate/provider";
import type {
  BrewvaModelPresetState,
  BrewvaPromptSessionEvent,
  BrewvaQueuedPromptView,
  BrewvaSessionModelDescriptor,
  BrewvaShellViewPreferences,
  BrewvaSteerOutcome,
} from "@brewva/brewva-substrate/session";
import type { BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import type { DelegationRunRecord } from "@brewva/brewva-vocabulary/delegation";
import type {
  DecideEffectCommitmentInput,
  PendingEffectCommitmentRequest,
} from "@brewva/brewva-vocabulary/iteration";
import type { BrewvaReplaySession, SkillDocument } from "@brewva/brewva-vocabulary/session";
import type { SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import {
  createCliInspectPort,
  createCliOperatorPort,
} from "../../packages/brewva-cli/src/runtime/cli-runtime-ports.js";
import {
  CliShellRuntime,
  type CliShellRuntimeOptions,
} from "../../packages/brewva-cli/src/shell/controller/shell-runtime.js";
import type {
  ProviderAuthMethod,
  ProviderConnectionDescriptor,
  ProviderOAuthAuthorization,
} from "../../packages/brewva-cli/src/shell/domain/overlays/payloads.js";
import type { CliShellSessionBundle } from "../../packages/brewva-cli/src/shell/ports/session-port.js";
import type { HostedRuntimeAdapterPort } from "../../packages/brewva-gateway/src/hosted/api.js";
import {
  fauxAssistantMessage,
  registerFauxProvider,
} from "../../packages/brewva-provider-core/src/providers/faux/index.js";
import { createManualShellClock, type ManualShellClock } from "./manual-shell-clock.js";
import { createRuntimeProviderFaceFixture } from "./runtime-provider-face.js";
import { createRuntimeInstanceFixture } from "./runtime.js";

/**
 * Shared fake session bundle for shell runtime and renderer tests.
 *
 * This is the canonical replacement for the per-file `createFakeBundle`
 * copies in the older unit tests; new tests should use this helper so the
 * bundle surface evolves in one place.
 */
export interface ShellFixtureOptions {
  sessionId?: string;
  /** Seed messages returned from the session context (transcript seed). */
  transcriptSeed?: unknown[];
  /** Invoked with the flattened prompt text whenever the session is prompted. */
  promptHandler?: (text: string) => Promise<void> | void;
  /** Invoked with the raw prompt parts whenever the session is prompted. */
  promptPartsHandler?: (parts: readonly BrewvaPromptContentPart[]) => Promise<void> | void;
  abortHandler?: () => Promise<void> | void;
  /**
   * Steering hook. In the stub fixture `session.steer` only exists when this
   * is provided so submit-while-streaming routing matches sessions without a
   * steer capability; the hosted fixture always exposes `steer`.
   */
  steerHandler?: (text: string) => Promise<BrewvaSteerOutcome>;
  queuedPrompts?: BrewvaQueuedPromptView[];
  models?: BrewvaSessionModelDescriptor[];
  availableModelKeys?: string[];
  replaySessions?: BrewvaReplaySession[];
  sessionWireBySessionId?: Record<string, SessionWireFrame[]>;
  taskRuns?: DelegationRunRecord[];
  toolDefinitions?: Map<string, BrewvaToolDefinition>;
  isStreaming?: boolean;
  /** Model preset state; preset selection methods exist on the hosted fixture session only. */
  modelPresetState?: BrewvaModelPresetState;
  /** Number of synthetic pending approvals to expose from proposals.listPending. */
  approvals?: number;
  /** Explicit pending approvals; takes precedence over `approvals`. */
  approvalRequests?: PendingEffectCommitmentRequest[];
  /** Stub fixture only: invoked when an approval is decided; the request is removed from pending. */
  onApprovalDecision?: (requestId: string, input: DecideEffectCommitmentInput) => void;
  /** Skills exposed through runtime.ops.skills.catalog (stub fixture only). */
  skills?: SkillDocument[];
  providers?: ProviderConnectionDescriptor[];
  authMethods?: Record<string, ProviderAuthMethod[]>;
  authorizeOAuth?: (
    provider: string,
    methodId: string,
    inputs?: Record<string, string>,
  ) => Promise<ProviderOAuthAuthorization | undefined>;
  completeOAuth?: (provider: string, methodId: string, code?: string) => Promise<void>;
}

export interface ShellFixture {
  readonly bundle: CliShellSessionBundle;
  readonly emitSessionEvent: (event: BrewvaPromptSessionEvent) => void;
  readonly getAttachedUi: () => BrewvaToolUiPort | undefined;
  readonly setApprovalRequests: (next: PendingEffectCommitmentRequest[]) => void;
  readonly setStreaming: (next: boolean) => void;
  /** API keys captured through providerConnections.credential.connectApiKey. */
  readonly providerConnects: Array<{ provider: string; key: string }>;
  readonly getCurrentModel: () => BrewvaSessionModelDescriptor;
  readonly getDiffPreferences: () => { style: "auto" | "stacked"; wrapMode: "word" | "none" };
  readonly getShellViewPreferences: () => BrewvaShellViewPreferences;
}

function modelKeyOf(model: Pick<BrewvaSessionModelDescriptor, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

function toRuntimeProviderModel(model: BrewvaSessionModelDescriptor): BrewvaRegisteredModel {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name ?? model.id,
    api: model.api ?? "openai-responses",
    baseUrl: model.baseUrl ?? "",
    reasoning: model.reasoning,
    input: [...(model.input ?? ["text"])],
    cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    headers: model.headers,
    displayName: model.displayName,
  };
}

function buildPendingApprovals(options: ShellFixtureOptions): PendingEffectCommitmentRequest[] {
  if (options.approvalRequests) {
    return [...options.approvalRequests];
  }
  return Array.from({ length: options.approvals ?? 0 }, (_, index) => ({
    requestId: `approval-${index + 1}`,
    proposalId: `proposal-${index + 1}`,
    toolName: "write_file",
    toolCallId: `tool-call-${index + 1}`,
    subject: `write file ${index + 1}`,
    boundary: "effectful",
    effects: ["workspace_write"],
    argsDigest: `digest-${index + 1}`,
    evidenceRefs: [],
    turn: index + 1,
    createdAt: Date.now(),
  })) as unknown as PendingEffectCommitmentRequest[];
}

function buildProviderConnections(
  options: ShellFixtureOptions,
  providerConnects: Array<{ provider: string; key: string }>,
): object | undefined {
  if (!options.providers) {
    return undefined;
  }
  const listAuthMethods = (provider: string) =>
    options.authMethods?.[provider] ?? [
      {
        id: "api_key" as const,
        kind: "api_key" as const,
        type: "api" as const,
        label: "API key",
        credentialRef: `vault://${provider}/apiKey`,
      },
    ];
  return {
    catalog: {
      async listProviders() {
        return options.providers ?? [];
      },
    },
    renderer: {
      listAuthMethods,
    },
    credential: {
      async listProviders() {
        return options.providers ?? [];
      },
      async connectApiKey(provider: string, key: string) {
        providerConnects.push({ provider, key });
      },
      async disconnect() {},
      async refresh() {},
    },
    authFlow: {
      listAuthMethods,
      async authorizeOAuth(provider: string, methodId: string, inputs?: Record<string, string>) {
        return options.authorizeOAuth?.(provider, methodId, inputs);
      },
      async completeOAuth(provider: string, methodId: string, code?: string) {
        await options.completeOAuth?.(provider, methodId, code);
      },
    },
  };
}

export function createShellFixture(options: ShellFixtureOptions = {}): ShellFixture {
  let attachedUi: BrewvaToolUiPort | undefined;
  let sessionListener: ((event: BrewvaPromptSessionEvent) => void) | undefined;
  const queuedPrompts = [...(options.queuedPrompts ?? [])];
  let approvals = buildPendingApprovals(options);
  const providerConnects: Array<{ provider: string; key: string }> = [];
  const sessionId = options.sessionId ?? "session-1";
  const defaultModel: BrewvaSessionModelDescriptor = {
    provider: "openai",
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    contextWindow: 128_000,
    maxTokens: 16_384,
    reasoning: true,
  };
  const allModels = options.models ?? [defaultModel];
  const availableModelKeys = new Set(options.availableModelKeys ?? allModels.map(modelKeyOf));
  let currentModel = allModels[0] ?? defaultModel;
  let thinkingLevel = "high";
  let diffPreferences: { style: "auto" | "stacked"; wrapMode: "word" | "none" } = {
    style: "auto",
    wrapMode: "word",
  };
  let shellViewPreferences: BrewvaShellViewPreferences = {
    showThinking: true,
    toolDetails: true,
  };
  const replaySessions = options.replaySessions ?? [
    {
      sessionId,
      eventCount: 1,
      lastEventAt: Date.now(),
      title: "New session",
    },
  ];
  const skills = options.skills ?? [];

  const session = {
    get model() {
      return currentModel;
    },
    get thinkingLevel() {
      return thinkingLevel;
    },
    modelRegistry: {
      getAll() {
        return allModels;
      },
      getAvailable() {
        return allModels.filter((model) => availableModelKeys.has(modelKeyOf(model)));
      },
    },
    isStreaming: options.isStreaming ?? false,
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
      buildSessionContext() {
        return { messages: options.transcriptSeed ?? [] };
      },
    },
    settingsManager: {
      getQuietStartup() {
        return false;
      },
      getModelPreferences() {
        return { recent: [], favorite: [] };
      },
      setModelPreferences() {},
      getDiffPreferences() {
        return diffPreferences;
      },
      setDiffPreferences(next: typeof diffPreferences) {
        diffPreferences = next;
      },
      getShellViewPreferences() {
        return shellViewPreferences;
      },
      setShellViewPreferences(next: BrewvaShellViewPreferences) {
        shellViewPreferences = next;
      },
    },
    subscribe(listener: (event: BrewvaPromptSessionEvent) => void) {
      sessionListener = listener;
      return () => {
        if (sessionListener === listener) {
          sessionListener = undefined;
        }
      };
    },
    async prompt(parts: readonly BrewvaPromptContentPart[]) {
      await options.promptPartsHandler?.(parts);
      if (options.promptHandler) {
        await options.promptHandler(buildBrewvaPromptText(parts));
      }
    },
    ...(options.steerHandler
      ? {
          async steer(text: string) {
            return options.steerHandler?.(text) ?? { status: "no_active_run" };
          },
        }
      : {}),
    getQueuedPrompts() {
      return queuedPrompts;
    },
    removeQueuedPrompt(promptId: string) {
      const index = queuedPrompts.findIndex((item) => item.promptId === promptId);
      if (index < 0) {
        return false;
      }
      queuedPrompts.splice(index, 1);
      sessionListener?.({
        type: "queue.changed",
        items: [...queuedPrompts],
      });
      return true;
    },
    async waitForIdle() {},
    async abort() {
      await options.abortHandler?.();
    },
    async setModel(model: BrewvaSessionModelDescriptor) {
      currentModel = model;
    },
    getAvailableThinkingLevels() {
      return currentModel.reasoning ? ["off", "minimal", "low", "medium", "high"] : ["off"];
    },
    setThinkingLevel(level: string) {
      thinkingLevel = level;
    },
    dispose() {},
    setUiPort(ui: BrewvaToolUiPort) {
      attachedUi = ui;
    },
  };

  const runtime = {
    identity: {
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      agentId: "test-agent",
    },
    ops: {
      session: {
        rewind: {
          recordCheckpoint() {},
          rewind() {
            return { ok: false, reason: "no_checkpoint" };
          },
          redo() {
            return { ok: false, reason: "no_redo" };
          },
          getState() {
            return {
              checkpoints: [],
              rewindAvailable: false,
              redoAvailable: false,
              redoStack: [],
            };
          },
          listTargets() {
            return [];
          },
        },
        lineage: {
          getContextEntryPath() {
            return [];
          },
        },
      },
      skills: {
        catalog: {
          getLoadReport() {
            return {
              roots: [],
              loadedSkills: skills.map((skill) => skill.name),
              selectableSkills: skills.map((skill) => skill.name),
              overlaySkills: [],
              categories: {},
            };
          },
          list() {
            return skills;
          },
        },
      },
      proposals: {
        requests: {
          decide(_sessionId: string, requestId: string, input: DecideEffectCommitmentInput) {
            options.onApprovalDecision?.(requestId, input);
            approvals = approvals.filter((approval) => approval.requestId !== requestId);
          },
          listPending() {
            return approvals;
          },
          list() {
            return [];
          },
        },
      },
      events: {
        records: {
          list() {
            return [];
          },
          query() {
            return [];
          },
        },
        replay: {
          listSessions() {
            return replaySessions;
          },
        },
      },
      sessionWire: {
        query(targetSessionId: string) {
          return options.sessionWireBySessionId?.[targetSessionId] ?? [];
        },
      },
    },
  } as unknown as HostedRuntimeAdapterPort;

  const bundle = {
    session,
    toolDefinitions: options.toolDefinitions ?? new Map(),
    runtime,
    inspect: createCliInspectPort(runtime),
    operator: createCliOperatorPort(runtime),
    orchestration: {
      subagents: {
        async status() {
          return {
            ok: true,
            runs: options.taskRuns ?? [],
          };
        },
        async cancel() {
          return {
            ok: false,
            error: "not_live",
          };
        },
      },
    },
    providerConnections: buildProviderConnections(options, providerConnects),
  } as unknown as CliShellSessionBundle;

  return {
    bundle,
    emitSessionEvent(event: BrewvaPromptSessionEvent) {
      sessionListener?.(event);
    },
    getAttachedUi: () => attachedUi,
    setApprovalRequests(next: PendingEffectCommitmentRequest[]) {
      approvals = next;
    },
    setStreaming(next: boolean) {
      (session as { isStreaming: boolean }).isStreaming = next;
    },
    providerConnects,
    getCurrentModel: () => currentModel,
    getDiffPreferences: () => diffPreferences,
    getShellViewPreferences: () => shellViewPreferences,
  };
}

export interface HostedShellFixtureOptions extends ShellFixtureOptions {
  /**
   * Register a faux provider for the lifetime of the fixture and use its
   * model as the default; prompts route through the faux provider responses.
   */
  fauxProvider?: boolean;
}

export interface HostedShellFixture extends ShellFixture {
  /** Approval decisions captured through runtime.ops.proposals.requests.decide. */
  readonly approvalDecisions: Array<{ requestId: string; input: unknown }>;
  readonly getModelPreferences: () => {
    recent: Array<{ provider: string; id: string }>;
    favorite: Array<{ provider: string; id: string }>;
  };
  readonly getModelPresetState: () => BrewvaModelPresetState;
}

function latestUserTextFromProviderContext(context: ProviderContext): string {
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index];
    if (message?.role !== "user") {
      continue;
    }
    return message.content
      .map((part) => {
        if (part.type === "text") {
          return part.text;
        }
        if (part.type === "file") {
          return part.displayText ?? part.name ?? part.uri;
        }
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * Shell session bundle backed by a real hosted runtime instance (with a
 * temp-dir workspace), for shell runtime controller tests that exercise
 * real runtime ops (lineage, events records, rewind) or patch them.
 */
export function createHostedShellFixture(
  options: HostedShellFixtureOptions = {},
): HostedShellFixture {
  let attachedUi: BrewvaToolUiPort | undefined;
  let sessionListener: ((event: BrewvaPromptSessionEvent) => void) | undefined;
  const queuedPrompts = [...(options.queuedPrompts ?? [])];
  const approvalDecisions: Array<{ requestId: string; input: unknown }> = [];
  const providerConnects: Array<{ provider: string; key: string }> = [];
  const sessionId = options.sessionId ?? "session-1";
  const replaySessions = options.replaySessions ?? [
    {
      sessionId,
      eventCount: 1,
      lastEventAt: Date.now(),
      title: "New session",
    },
  ];
  const runtime = createRuntimeInstanceFixture({
    cwd: mkdtempSync(join(tmpdir(), "brewva-shell-runtime-")),
  });
  let fakeLeafEntryId: string | null = null;
  let fakeLineageNodeId = "lineage:main";
  Object.assign(runtime.ops.proposals.requests, {
    decide(_sessionId: string, requestId: string, input: unknown) {
      approvalDecisions.push({ requestId, input });
    },
    listPending() {
      return [];
    },
    list() {
      return [];
    },
  });
  Object.assign(runtime.ops.events.replay, {
    listSessions() {
      return replaySessions;
    },
  });
  const querySessionWire = runtime.ops.sessionWire.query.bind(runtime.ops.sessionWire);
  Object.assign(runtime.ops.sessionWire, {
    query(targetSessionId: string) {
      return options.sessionWireBySessionId?.[targetSessionId] ?? querySessionWire(targetSessionId);
    },
  });
  const fauxProvider = options.fauxProvider
    ? registerFauxProvider({
        provider: `faux-shell-runtime-${Math.random().toString(36).slice(2)}`,
        api: "faux",
        models: [
          {
            id: "faux-shell-1",
            name: "Faux Shell",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 128_000,
            maxTokens: 16_384,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
        tokenSize: { min: 1, max: 1 },
      })
    : undefined;
  const defaultModel = fauxProvider
    ? (fauxProvider.getModel() as unknown as BrewvaSessionModelDescriptor)
    : ({
        provider: "openai",
        id: "gpt-5.4-mini",
        name: "GPT-5.4 Mini",
        contextWindow: 128_000,
        maxTokens: 16_384,
        reasoning: true,
      } satisfies BrewvaSessionModelDescriptor);
  const allModels = options.models ?? [defaultModel];
  const availableModelKeys = new Set(options.availableModelKeys ?? allModels.map(modelKeyOf));
  let currentModel = allModels[0] ?? defaultModel;
  let thinkingLevel = "high";
  let isStreaming = options.isStreaming ?? false;
  let modelPresetState: BrewvaModelPresetState = options.modelPresetState ?? {
    activeName: "Default",
    defaultName: "Default",
    presets: [{ name: "Default", roles: {}, synthetic: true }],
  };
  let modelPreferences = { recent: [], favorite: [] } as {
    recent: Array<{ provider: string; id: string }>;
    favorite: Array<{ provider: string; id: string }>;
  };
  let diffPreferences: { style: "auto" | "stacked"; wrapMode: "word" | "none" } = {
    style: "auto",
    wrapMode: "word",
  };
  let shellViewPreferences: BrewvaShellViewPreferences = {
    showThinking: true,
    toolDetails: true,
  };
  const applyPendingModelPreset = () => {
    if (!modelPresetState.pendingName) {
      return;
    }
    modelPresetState = {
      ...modelPresetState,
      activeName: modelPresetState.pendingName,
      pendingName: undefined,
    };
  };
  fauxProvider?.setResponses(
    Array.from({ length: 64 }, () => async (context: ProviderContext) => {
      applyPendingModelPreset();
      await options.promptHandler?.(latestUserTextFromProviderContext(context));
      return fauxAssistantMessage("ok");
    }),
  );
  const runtimeProviderFace = createRuntimeProviderFaceFixture({
    getModel: () => toRuntimeProviderModel(currentModel),
    getModelCatalog() {
      return {
        async getApiKeyAndHeaders() {
          return { ok: true as const };
        },
      };
    },
  });

  const session = {
    get model() {
      return currentModel;
    },
    get thinkingLevel() {
      return thinkingLevel;
    },
    get isStreaming() {
      return isStreaming;
    },
    set isStreaming(next: boolean) {
      isStreaming = next;
    },
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
      getLeafId() {
        return fakeLeafEntryId;
      },
      getLineageNodeId() {
        return fakeLineageNodeId;
      },
      getBranch() {
        return [];
      },
      branch(entryId: string) {
        fakeLeafEntryId = entryId;
      },
      resetLeaf() {
        fakeLeafEntryId = null;
        fakeLineageNodeId = "lineage:main";
      },
      branchWithSummary() {
        return "summary:fake";
      },
      checkoutLineageNode(lineageNodeId: string, leafEntryId?: string | null) {
        fakeLineageNodeId = lineageNodeId;
        fakeLeafEntryId = leafEntryId ?? null;
      },
      resolveLineageLeafEntryId(_lineageNodeId: string) {
        return null;
      },
      buildSessionContext() {
        return { messages: options.transcriptSeed ?? [] };
      },
    },
    settingsManager: {
      getQuietStartup() {
        return false;
      },
      getModelPreferences() {
        return modelPreferences;
      },
      setModelPreferences(next: typeof modelPreferences) {
        modelPreferences = next;
      },
      getDiffPreferences() {
        return diffPreferences;
      },
      setDiffPreferences(next: typeof diffPreferences) {
        diffPreferences = next;
      },
      getShellViewPreferences() {
        return shellViewPreferences;
      },
      setShellViewPreferences(next: BrewvaShellViewPreferences) {
        shellViewPreferences = next;
      },
    },
    modelRegistry: {
      getAll() {
        return allModels;
      },
      getAvailable() {
        return allModels.filter((model) => availableModelKeys.has(modelKeyOf(model)));
      },
    },
    async setModel(model: BrewvaSessionModelDescriptor) {
      currentModel = model;
    },
    getModelPresetState() {
      return structuredClone(modelPresetState);
    },
    selectModelPreset(request: { name: string }) {
      const preset = modelPresetState.presets.find((candidate) => candidate.name === request.name);
      if (!preset) {
        throw new Error(`Unknown model preset: ${request.name}`);
      }
      const previousName = modelPresetState.activeName;
      modelPresetState = {
        ...modelPresetState,
        activeName: preset.name,
        pendingName: undefined,
      };
      return {
        selectedName: preset.name,
        previousName,
        modelChanged: false,
        queued: false,
        effectiveDefaultModel: preset.roles.default,
      };
    },
    queueModelPresetForNextTurn(name: string) {
      const preset = modelPresetState.presets.find((candidate) => candidate.name === name);
      if (!preset) {
        throw new Error(`Unknown model preset: ${name}`);
      }
      modelPresetState = {
        ...modelPresetState,
        pendingName: preset.name,
      };
      return {
        selectedName: preset.name,
        previousName: modelPresetState.activeName,
        modelChanged: false,
        queued: true,
        effectiveDefaultModel: preset.roles.default,
      };
    },
    getAvailableThinkingLevels() {
      return currentModel.reasoning ? ["off", "minimal", "low", "medium", "high"] : ["off"];
    },
    setThinkingLevel(level: string) {
      thinkingLevel = level;
    },
    subscribe(listener: (event: BrewvaPromptSessionEvent) => void) {
      sessionListener = listener;
      return () => {
        if (sessionListener === listener) {
          sessionListener = undefined;
        }
      };
    },
    async prompt(parts: readonly BrewvaPromptContentPart[]) {
      applyPendingModelPreset();
      await options.promptPartsHandler?.(parts);
      if (options.promptHandler) {
        await options.promptHandler(buildBrewvaPromptText(parts));
      }
    },
    async steer(text: string) {
      return options.steerHandler?.(text) ?? { status: "no_active_run" };
    },
    getQueuedPrompts() {
      return queuedPrompts;
    },
    removeQueuedPrompt(promptId: string) {
      const index = queuedPrompts.findIndex((item) => item.promptId === promptId);
      if (index < 0) {
        return false;
      }
      queuedPrompts.splice(index, 1);
      sessionListener?.({
        type: "queue.changed",
        items: [...queuedPrompts],
      });
      return true;
    },
    async waitForIdle() {},
    async abort() {
      await options.abortHandler?.();
    },
    dispose() {
      fauxProvider?.unregister();
    },
    setUiPort(ui: BrewvaToolUiPort) {
      attachedUi = ui;
    },
    getRegisteredTools() {
      return [];
    },
    getRuntimeProviderFace() {
      return runtimeProviderFace;
    },
    createRuntimeToolContext() {
      return {
        getSystemPrompt: () => "Shell runtime test system prompt.",
      };
    },
  };

  const bundle = {
    session,
    toolDefinitions: options.toolDefinitions ?? new Map(),
    runtime,
    inspect: createCliInspectPort(runtime as unknown as HostedRuntimeAdapterPort),
    operator: createCliOperatorPort(runtime as unknown as HostedRuntimeAdapterPort),
    providerConnections: buildProviderConnections(options, providerConnects),
  } as unknown as CliShellSessionBundle;

  return {
    bundle,
    emitSessionEvent(event: BrewvaPromptSessionEvent) {
      sessionListener?.(event);
    },
    getAttachedUi: () => attachedUi,
    setApprovalRequests() {
      throw new Error("setApprovalRequests is not supported by the hosted shell fixture.");
    },
    setStreaming(next: boolean) {
      isStreaming = next;
    },
    providerConnects,
    approvalDecisions,
    getCurrentModel: () => currentModel,
    getDiffPreferences: () => diffPreferences,
    getShellViewPreferences: () => shellViewPreferences,
    getModelPreferences: () => modelPreferences,
    getModelPresetState: () => structuredClone(modelPresetState),
  };
}

export interface ShellRuntimeFixtureOptions extends ShellFixtureOptions {
  runtimeOptions?: Partial<CliShellRuntimeOptions>;
}

export interface ShellRuntimeFixture extends ShellFixture {
  readonly runtime: CliShellRuntime;
  readonly clock: ManualShellClock;
  /** Number of change notifications emitted to renderer subscribers. */
  emitCount(): number;
  dispose(): void;
}

/**
 * Start a shell runtime over a fake bundle with a deterministic manual
 * clock. All shell debounce/throttle timers fire only when the test
 * advances the clock, so streaming cadence is fully controlled.
 */
export async function startShellRuntimeFixture(
  options: ShellRuntimeFixtureOptions = {},
): Promise<ShellRuntimeFixture> {
  const fixture = createShellFixture(options);
  const clock = createManualShellClock();
  const runtime = new CliShellRuntime(fixture.bundle, {
    cwd: process.cwd(),
    openSession: async () => fixture.bundle,
    createSession: async () => fixture.bundle,
    operatorPollIntervalMs: 600_000,
    clock,
    ...options.runtimeOptions,
  });
  let emits = 0;
  const unsubscribe = runtime.subscribe(() => {
    emits += 1;
  });
  await runtime.start();
  return {
    ...fixture,
    runtime,
    clock,
    emitCount: () => emits,
    dispose() {
      unsubscribe();
      runtime.dispose();
    },
  };
}
