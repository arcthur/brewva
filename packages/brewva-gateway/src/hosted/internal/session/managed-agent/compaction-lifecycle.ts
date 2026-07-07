import { randomUUID } from "node:crypto";
import type { BrewvaAgentProtocolController } from "@brewva/brewva-substrate/agent-protocol";
import {
  estimateBrewvaCompactedContextTokens,
  estimateBrewvaCompactionTokens,
  pruneCompactionInput,
} from "@brewva/brewva-substrate/compaction";
import { resolveWindowScaledTokens } from "@brewva/brewva-substrate/context-budget";
import type { BrewvaHostContext, BrewvaHostPluginRunner } from "@brewva/brewva-substrate/host-api";
import type { BrewvaMutableModelCatalog } from "@brewva/brewva-substrate/provider";
import type { BrewvaPromptSessionEvent } from "@brewva/brewva-substrate/session";
import { SESSION_PRE_COMPACT_PRUNE_SCHEMA_V1 } from "@brewva/brewva-vocabulary/session";
import type { SessionPreCompactPrunePayload } from "@brewva/brewva-vocabulary/session";
import type { DeferredCompactionSalvageMode } from "../../compaction/deferred.js";
import {
  buildCompactionSummaryGenerationMetadata,
  compactionFallbackReason,
  type PendingCompactionRequestState,
  nonNegativeUsageNumber,
  type ResolvedCompactionSummary,
  sameSessionMessages,
} from "../../compaction/flow.js";
import {
  generateCompactionSummaryWithPromptTooLargeRetry,
  LLM_PRIMARY_COMPACTION_STRATEGY,
  normalizeCompactionSummaryForStorage,
  resolveCompactionFallbackSummary,
  type BrewvaCompactionSummaryGenerator,
} from "../../compaction/summary-generator.js";
import { selectStaleAwareWorkbenchEntriesForSession } from "../../context/workbench-staleness.js";
import {
  getRuntimeContextUsage,
  recordRuntimeAssistantCost,
  type HostedRuntimeAdapterPort,
} from "../runtime-ports.js";
import type {
  BuiltDeferredCompactionEvents,
  ManagedAgentSessionStore,
  PreparedDeferredCompaction,
} from "./session-contracts.js";

export interface ManagedSessionCompactionLifecycleOptions {
  cwd: string;
  runtime: HostedRuntimeAdapterPort;
  agentState: () => BrewvaAgentProtocolController["state"];
  catalog: BrewvaMutableModelCatalog;
  compactionSummaryGenerator: BrewvaCompactionSummaryGenerator;
  sessionManager: ManagedAgentSessionStore;
  runner: BrewvaHostPluginRunner;
  createHostContext: () => BrewvaHostContext;
  emitToListeners: (event: BrewvaPromptSessionEvent) => void;
  replaceMessages: (messages: unknown) => Promise<void>;
  markSessionCompacted: () => Promise<void>;
}

/** Cap on workbench notes promoted into a workbench-primary fallback summary. */
const FALLBACK_WORKBENCH_SUMMARY_MAX_ENTRIES = 20;

export class ManagedSessionCompactionLifecycle {
  readonly #cwd: string;
  readonly #runtime: HostedRuntimeAdapterPort;
  readonly #agentState: ManagedSessionCompactionLifecycleOptions["agentState"];
  readonly #catalog: BrewvaMutableModelCatalog;
  readonly #compactionSummaryGenerator: BrewvaCompactionSummaryGenerator;
  readonly #sessionManager: ManagedAgentSessionStore;
  readonly #runner: BrewvaHostPluginRunner;
  readonly #createHostContext: ManagedSessionCompactionLifecycleOptions["createHostContext"];
  readonly #emitToListeners: ManagedSessionCompactionLifecycleOptions["emitToListeners"];
  readonly #replaceMessages: ManagedSessionCompactionLifecycleOptions["replaceMessages"];
  readonly #markSessionCompacted: ManagedSessionCompactionLifecycleOptions["markSessionCompacted"];

  constructor(options: ManagedSessionCompactionLifecycleOptions) {
    this.#cwd = options.cwd;
    this.#runtime = options.runtime;
    this.#agentState = options.agentState;
    this.#catalog = options.catalog;
    this.#compactionSummaryGenerator = options.compactionSummaryGenerator;
    this.#sessionManager = options.sessionManager;
    this.#runner = options.runner;
    this.#createHostContext = options.createHostContext;
    this.#emitToListeners = options.emitToListeners;
    this.#replaceMessages = options.replaceMessages;
    this.#markSessionCompacted = options.markSessionCompacted;
  }

  private async resolveCompactionSummary(input: {
    sessionId: string;
    messages: readonly unknown[];
    customInstructions?: string;
  }): Promise<ResolvedCompactionSummary> {
    try {
      const stateModel = this.#agentState().model;
      const model = stateModel ? this.#catalog.find(stateModel.provider, stateModel.id) : undefined;
      if (!model) {
        throw new Error("compaction_summary_model_unavailable");
      }
      const generated = await generateCompactionSummaryWithPromptTooLargeRetry({
        input: {
          sessionId: input.sessionId,
          cwd: this.#cwd,
          model,
          messages: input.messages,
          systemPrompt: this.#agentState().systemPrompt,
          customInstructions: input.customInstructions,
        },
        generate: this.#compactionSummaryGenerator,
      });
      return {
        summary: normalizeCompactionSummaryForStorage(generated.summary),
        strategy: generated.strategy ?? LLM_PRIMARY_COMPACTION_STRATEGY,
        model: generated.model ?? {
          provider: model.provider,
          id: model.id,
          api: model.api,
        },
        usage: generated.usage,
      };
    } catch (error) {
      // LLM summarization failed: prefer the model-authored workbench notebook,
      // falling back to the deterministic projection only when it has no note
      // content, so the canonical artifact is never undefined.
      const fallback = resolveCompactionFallbackSummary({
        workbenchEntries: selectStaleAwareWorkbenchEntriesForSession(
          this.#runtime,
          input.sessionId,
          FALLBACK_WORKBENCH_SUMMARY_MAX_ENTRIES,
        ),
        messages: input.messages,
      });
      return {
        summary: fallback.summary,
        strategy: fallback.strategy,
        fallbackReason: compactionFallbackReason(error),
      };
    }
  }

  private recordCompactionGenerationCost(
    sessionId: string,
    resolution: ResolvedCompactionSummary,
  ): void {
    if (!this.#runtime || !resolution.model || !resolution.usage) {
      return;
    }
    recordRuntimeAssistantCost(this.#runtime, {
      sessionId,
      model: `${resolution.model.provider}/${resolution.model.id}`,
      inputTokens: nonNegativeUsageNumber(resolution.usage.input),
      outputTokens: nonNegativeUsageNumber(resolution.usage.output),
      cacheReadTokens: nonNegativeUsageNumber(resolution.usage.cacheRead),
      cacheWriteTokens: nonNegativeUsageNumber(resolution.usage.cacheWrite),
      totalTokens: nonNegativeUsageNumber(resolution.usage.totalTokens),
      costUsd: nonNegativeUsageNumber(resolution.usage.cost?.total),
      stopReason: "compaction_summary",
    });
  }

  /**
   * Emit the pre-compaction prune receipt onto the runtime tape as advisory
   * telemetry — durable and replayable, but NOT materialized into context (it
   * rides the runtime tape, not the session branch that `buildSessionContext`
   * projects). Joined to the compaction by `compactId`. Emitted by finalize only
   * AFTER the session_compact commit lands, so neither a rolled-back preview nor a
   * failed commit leaves an orphan receipt; the rare salvage recovery path
   * intentionally does not re-emit it. No-op when nothing pruned.
   */
  private recordPreCompactPrune(prepared: PreparedDeferredCompaction): void {
    if (prepared.pruneOperations.length === 0) {
      return;
    }
    const payload: SessionPreCompactPrunePayload = {
      schema: SESSION_PRE_COMPACT_PRUNE_SCHEMA_V1,
      sessionId: prepared.sessionId,
      compactId: prepared.preview.compactId,
      operations: prepared.pruneOperations,
      tokensSaved: prepared.pruneTokensSaved,
    };
    this.#runtime.ops.context.telemetry.preCompactPrune({
      sessionId: prepared.sessionId,
      payload,
    });
  }

  async preview(request: PendingCompactionRequestState): Promise<PreparedDeferredCompaction> {
    const branchEntries = this.#sessionManager.getBranch();
    const originalContext = this.#sessionManager.buildSessionContext();
    const sessionId = this.#sessionManager.getSessionId();
    const sourceLeafEntryId = this.#sessionManager.getLeafId() ?? null;
    // Deterministically prune redundancy out of the LLM summarizer's input before
    // paying for it (dedupe / inform-replace / image-strip of old tool results).
    // This never mutates the tape or the retained tail — only what the summarizer
    // reads. The receipt is emitted at commit time (finalize), joined by compactId.
    const compactionConfig = this.#runtime.config.infrastructure.contextBudget.compaction;
    // Resolve the tail-protect window the same way every other compaction/reduction
    // consumer does: an absolute token override wins, else the ratio scales with the
    // live context window. Reading tailProtectTokens alone ignored tailProtectRatio
    // (defaults null / 0.2), so the prune silently fell back to its own 40k default.
    const resolvedTailProtectTokens = resolveWindowScaledTokens(
      compactionConfig.tailProtectTokens,
      compactionConfig.tailProtectRatio,
      getRuntimeContextUsage(this.#runtime, sessionId)?.contextWindow,
    );
    const prune = compactionConfig.pruneEnabled
      ? pruneCompactionInput(originalContext.messages, {
          protectedTools: compactionConfig.protectedTools,
          ...(resolvedTailProtectTokens !== null
            ? { tailProtectTokens: resolvedTailProtectTokens }
            : {}),
        })
      : null;
    const summaryResolution = await this.resolveCompactionSummary({
      sessionId,
      messages: prune?.messages ?? originalContext.messages,
      customInstructions: request.customInstructions,
    });
    const summary = summaryResolution.summary;
    const summaryGeneration = buildCompactionSummaryGenerationMetadata(summaryResolution);
    this.recordCompactionGenerationCost(sessionId, summaryResolution);
    const tokensBefore = estimateBrewvaCompactionTokens(originalContext.messages);
    const preview = this.#sessionManager.previewCompaction(
      summary,
      tokensBefore,
      randomUUID(),
      sourceLeafEntryId,
    );
    return {
      request,
      sessionId,
      branchEntries,
      originalContext,
      sourceLeafEntryId,
      summary,
      summaryGeneration,
      preview,
      pruneOperations: prune?.operations ?? [],
      pruneTokensSaved: prune?.tokensSaved ?? 0,
    };
  }

  build(prepared: PreparedDeferredCompaction): BuiltDeferredCompactionEvents {
    return {
      beforeCompactEvent: {
        type: "session_before_compact",
        preparation: {
          ...prepared.summaryGeneration,
        },
        branchEntries: prepared.branchEntries,
        customInstructions: prepared.request.customInstructions,
      },
      compactEvent: {
        type: "session_compact",
        compactionEntry: {
          id: prepared.preview.compactId,
          summary: prepared.summary,
          content: prepared.summary,
          text: prepared.summary,
          sourceLeafEntryId: prepared.preview.sourceLeafEntryId,
          firstKeptEntryId: prepared.preview.firstKeptEntryId,
          tokensBefore: prepared.preview.tokensBefore,
          toTokens: estimateBrewvaCompactedContextTokens(prepared.preview.context.messages),
          cutPointReason: prepared.preview.cutPointReason,
          summaryGeneration: prepared.summaryGeneration,
        },
        fromExtension: false,
      },
    };
  }

  async finalize(
    prepared: PreparedDeferredCompaction,
    built: BuiltDeferredCompactionEvents,
  ): Promise<void> {
    await this.#runner.emit(
      "session_before_compact",
      built.beforeCompactEvent,
      this.#createHostContext(),
    );
    this.#emitToListeners(built.beforeCompactEvent);
    await this.#replaceMessages(prepared.preview.context.messages);
    await this.#runner.emit("session_compact", built.compactEvent, this.#createHostContext());
    // Emit the prune receipt only AFTER the session_compact commit lands, so a
    // failed replace/commit can never leave a prune receipt with no compaction
    // behind it (an orphan the tape would show as a prune-without-compact).
    this.recordPreCompactPrune(prepared);
    this.#emitToListeners(built.compactEvent);
    await this.#markSessionCompacted();
    prepared.request.onComplete?.(built.compactEvent);
  }

  async salvage(
    prepared: PreparedDeferredCompaction,
    built: BuiltDeferredCompactionEvents,
    mode: DeferredCompactionSalvageMode,
  ): Promise<boolean> {
    if (mode === "persisted-preview") {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await Promise.resolve();
        await new Promise((settle) => setTimeout(settle, 0));
        const persistedBranch = this.#sessionManager.getBranch();
        const persistedLeaf = persistedBranch[persistedBranch.length - 1];
        const persistedContext = this.#sessionManager.buildSessionContext();
        if (
          (persistedLeaf?.type === "compaction" &&
            persistedLeaf.summary === prepared.summary &&
            persistedLeaf.firstKeptEntryId === prepared.preview.firstKeptEntryId &&
            persistedLeaf.tokensBefore === prepared.preview.tokensBefore) ||
          sameSessionMessages(persistedContext.messages, prepared.preview.context.messages)
        ) {
          await this.#replaceMessages(persistedContext.messages);
          this.#emitToListeners(built.compactEvent);
          await this.#markSessionCompacted();
          prepared.request.onComplete?.(built.compactEvent);
          return true;
        }
      }
      return false;
    }

    await Promise.resolve();
    await new Promise((settle) => setTimeout(settle, 0));
    const settledBranch = this.#sessionManager.getBranch();
    const settledLeaf = settledBranch[settledBranch.length - 1];
    if (settledLeaf?.type !== "compaction") {
      return false;
    }
    const settledContext = this.#sessionManager.buildSessionContext();
    await this.#replaceMessages(settledContext.messages);
    this.#emitToListeners(built.compactEvent);
    await this.#markSessionCompacted();
    prepared.request.onComplete?.(built.compactEvent);
    return true;
  }

  async rollback(prepared: PreparedDeferredCompaction): Promise<void> {
    await this.#replaceMessages(prepared.originalContext.messages);
  }
}
