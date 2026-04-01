import {
  createHostedTurnPipeline,
  registerContextTransform,
} from "@brewva/brewva-gateway/runtime-plugins";
import {
  CONTEXT_SOURCES,
  CONTEXT_SOURCE_BUDGET_CLASSES,
  type ContextInjectionBudgetClass,
  type ContextInjectionEntry,
} from "@brewva/brewva-runtime";
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

export function makeInjectedEntry(
  source: string,
  id: string,
  content: string,
  estimatedTokens = 8,
  budgetClass?: ContextInjectionBudgetClass,
): ContextInjectionEntry {
  const resolvedBudgetClass =
    budgetClass ??
    (CONTEXT_SOURCE_BUDGET_CLASSES as Record<string, ContextInjectionBudgetClass>)[source] ??
    "core";
  return {
    category: "narrative",
    budgetClass: resolvedBudgetClass,
    source,
    id,
    content,
    estimatedTokens,
    timestamp: 1,
    oncePerSession: false,
    truncated: false,
  };
}
