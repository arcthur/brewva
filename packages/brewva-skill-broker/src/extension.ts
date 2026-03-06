import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { CatalogSkillBroker, type CatalogSkillBrokerOptions } from "./catalog-broker.js";
import type { SkillBroker, SkillBrokerSelectInput } from "./types.js";

type SkillBrokerJudgeContext = NonNullable<SkillBrokerSelectInput["judgeContext"]>;

export interface CreateSkillBrokerExtensionOptions {
  runtime: BrewvaRuntime;
  broker?: SkillBroker;
  brokerOptions?: Omit<CatalogSkillBrokerOptions, "workspaceRoot" | "k">;
}

function resolveBrokerJudge(
  runtime: BrewvaRuntime,
  brokerOptions?: CreateSkillBrokerExtensionOptions["brokerOptions"],
): CatalogSkillBrokerOptions["judge"] | undefined {
  if (brokerOptions && "judge" in brokerOptions) {
    return brokerOptions.judge;
  }
  return runtime.config.skills.selector.brokerJudgeMode === "llm" ? undefined : null;
}

function resolveSessionId(ctx: unknown): string | null {
  if (!ctx || typeof ctx !== "object") return null;
  const sessionManager = (ctx as { sessionManager?: { getSessionId?: () => string } })
    .sessionManager;
  if (!sessionManager || typeof sessionManager.getSessionId !== "function") return null;
  return sessionManager.getSessionId();
}

function resolvePrompt(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const prompt = (event as { prompt?: unknown }).prompt;
  return typeof prompt === "string" ? prompt : "";
}

function resolveModel(ctx: unknown): SkillBrokerJudgeContext["model"] {
  if (!ctx || typeof ctx !== "object") return null;
  const model = (ctx as { model?: unknown }).model;
  if (!model || typeof model !== "object") return null;
  const provider = (model as { provider?: unknown }).provider;
  const id = (model as { id?: unknown }).id;
  return typeof provider === "string" && typeof id === "string"
    ? (model as SkillBrokerJudgeContext["model"])
    : null;
}

function resolveModelRegistry(ctx: unknown): SkillBrokerJudgeContext["modelRegistry"] {
  if (!ctx || typeof ctx !== "object") return null;
  const modelRegistry = (ctx as { modelRegistry?: unknown }).modelRegistry;
  if (!modelRegistry || typeof modelRegistry !== "object") return null;
  return typeof (modelRegistry as { getApiKey?: unknown }).getApiKey === "function"
    ? (modelRegistry as SkillBrokerJudgeContext["modelRegistry"])
    : null;
}

function registerSkillBrokerHandler(
  pi: ExtensionAPI,
  runtime: BrewvaRuntime,
  broker: SkillBroker,
): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    if (!sessionId) return undefined;
    const decision = await broker.select({
      sessionId,
      prompt: resolvePrompt(event),
      activeSkillName: runtime.skills.getActive(sessionId)?.name ?? null,
      judgeContext: {
        model: resolveModel(ctx),
        modelRegistry: resolveModelRegistry(ctx),
      },
    });
    runtime.skills.setNextSelection(sessionId, decision.selected, {
      routingOutcome: decision.routingOutcome,
    });
    return undefined;
  });
}

export function createSkillBrokerExtension(
  options: CreateSkillBrokerExtensionOptions,
): ExtensionFactory {
  return (pi) => {
    const broker =
      options.broker ??
      new CatalogSkillBroker({
        workspaceRoot: options.runtime.workspaceRoot,
        documents: () => options.runtime.skills.list(),
        k: options.runtime.config.skills.selector.k,
        ...options.brokerOptions,
        judge: resolveBrokerJudge(options.runtime, options.brokerOptions),
      });
    registerSkillBrokerHandler(pi, options.runtime, broker);
  };
}
