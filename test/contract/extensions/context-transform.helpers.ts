import {
  createBrewvaExtension,
  registerContextTransform,
} from "@brewva/brewva-gateway/runtime-plugins";
import { CONTEXT_SOURCES, type ContextInjectionEntry } from "@brewva/brewva-runtime";
import {
  createMockExtensionAPI,
  invokeHandler,
  invokeHandlerAsync,
  invokeHandlersAsync,
} from "../helpers/extension.js";
import { createRuntimeConfig, createRuntimeFixture } from "./fixtures/runtime.js";

export {
  CONTEXT_SOURCES,
  createBrewvaExtension,
  createMockExtensionAPI,
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
): ContextInjectionEntry {
  return {
    category: "narrative",
    source,
    id,
    content,
    estimatedTokens,
    timestamp: 1,
    oncePerSession: false,
    truncated: false,
  };
}
