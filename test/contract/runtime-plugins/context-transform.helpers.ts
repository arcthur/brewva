import {
  createHostedTurnPipeline,
  registerContextTransform,
} from "@brewva/brewva-gateway/runtime-plugins";
import { CONTEXT_SOURCES } from "@brewva/brewva-runtime";
import type { ContextInjectionEntry } from "@brewva/brewva-runtime/internal";
import {
  createMockRuntimePluginApi,
  invokeHandler,
  invokeHandlerAsync,
  invokeHandlersAsync,
} from "../../helpers/runtime-plugin.js";
import { createRuntimeConfig, createRuntimeFixture } from "./fixtures/runtime.js";

export {
  CONTEXT_SOURCES,
  createHostedTurnPipeline,
  createMockRuntimePluginApi,
  createRuntimeConfig,
  createRuntimeFixture,
  invokeHandler,
  invokeHandlerAsync,
  invokeHandlersAsync,
  registerContextTransform,
};

function resolveBudgetClass(source: string): "core" | "working" | "recall" {
  switch (source) {
    case CONTEXT_SOURCES.recoveryWorkingSet:
    case CONTEXT_SOURCES.toolOutputsDistilled:
    case CONTEXT_SOURCES.projectionWorking:
      return "working";
    case CONTEXT_SOURCES.recallBroker:
    case CONTEXT_SOURCES.narrativeMemory:
    case CONTEXT_SOURCES.deliberationMemory:
    case CONTEXT_SOURCES.optimizationContinuity:
    case CONTEXT_SOURCES.skillPromotionDrafts:
    case CONTEXT_SOURCES.skillRouting:
      return "recall";
    default:
      return "core";
  }
}

export function makeInjectedEntry(
  source: string,
  id: string,
  content: string,
  estimatedTokens = 8,
  budgetClass?: "core" | "working" | "recall",
): ContextInjectionEntry {
  const resolvedBudgetClass = budgetClass ?? resolveBudgetClass(source);
  return {
    category: "narrative",
    budgetClass: resolvedBudgetClass,
    selectionPriority: 10,
    preservationPolicy: "truncatable",
    source,
    id,
    content,
    estimatedTokens,
    timestamp: 1,
    oncePerSession: false,
    truncated: false,
  };
}
