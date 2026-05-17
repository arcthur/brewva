import type { DelegationContextRef, DelegationPacket } from "@brewva/brewva-tools/contracts";
import {
  buildContextBundle,
  deterministicTokenTruncate,
  type ContextBundleBlockInput,
  type ContextBundleBuildResult,
  type ContextBundleRef,
} from "../context/api.js";

function toBundleRef(ref: DelegationContextRef): ContextBundleRef {
  return {
    kind: ref.kind,
    locator: ref.locator,
    ...(ref.summary ? { summary: ref.summary } : {}),
    ...(ref.sourceSessionId ? { sourceSessionId: ref.sourceSessionId } : {}),
    ...(ref.hash ? { hash: ref.hash } : {}),
  };
}

function renderContextRef(ref: DelegationContextRef): string {
  const details = [
    ref.summary ? `summary=${ref.summary}` : null,
    ref.sourceSessionId ? `sourceSession=${ref.sourceSessionId}` : null,
    ref.hash ? `hash=${ref.hash}` : null,
  ].filter((part): part is string => Boolean(part));
  return `- [${ref.kind}] ${ref.locator}${details.length > 0 ? ` :: ${details.join(" | ")}` : ""}`;
}

export function buildDelegationContextBundle(input: {
  packet: DelegationPacket;
  inheritedBlock?: ContextBundleBlockInput;
  createdAt?: number;
}): ContextBundleBuildResult {
  const contextRefs = input.packet.contextRefs ?? [];
  const maxTokens = input.packet.contextBudget?.maxInjectionTokens;
  return buildContextBundle({
    scope: "delegation_prompt",
    sourceRefs: contextRefs.map(toBundleRef),
    blocks: [
      input.inheritedBlock,
      {
        id: "delegation-context-refs",
        content:
          contextRefs.length > 0
            ? ["## Context References", ...contextRefs.map(renderContextRef)].join("\n")
            : "",
        admission: "advisory",
        priority: 10,
        sourceRefIds: contextRefs.map((ref) => ref.locator),
        truncate: deterministicTokenTruncate,
      },
    ].filter((block): block is ContextBundleBlockInput => Boolean(block)),
    budget:
      typeof maxTokens === "number" && maxTokens > 0
        ? { maxTokens, overflow: "delegation_blocker" }
        : { overflow: "delegation_blocker" },
    createdAt: input.createdAt,
  });
}

export function buildForkContextBundle(input: {
  inheritedBlock?: ContextBundleBlockInput;
  maxInjectionTokens?: number;
  createdAt?: number;
}): ContextBundleBuildResult {
  return buildContextBundle({
    scope: "delegation_prompt",
    blocks: input.inheritedBlock
      ? [
          {
            ...input.inheritedBlock,
            id: "fork-inherited-parent-context",
          },
        ]
      : [],
    budget:
      typeof input.maxInjectionTokens === "number" && input.maxInjectionTokens > 0
        ? { maxTokens: input.maxInjectionTokens, overflow: "delegation_blocker" }
        : { overflow: "delegation_blocker" },
    createdAt: input.createdAt,
  });
}
