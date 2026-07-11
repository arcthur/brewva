import { runBoundaryOperation } from "@brewva/brewva-effect";
import { BrewvaEffect, BrewvaStream } from "@brewva/brewva-effect/primitives";
import type {
  Api,
  AssistantMessageEvent,
  AssistantMessage,
  Model as ProviderModel,
  SimpleStreamOptions as ProviderStreamOptions,
} from "@brewva/brewva-provider-core/contracts";
import { providerRuntimeLayer, readErrorStatus } from "@brewva/brewva-provider-core/contracts";
import type { RuntimeProviderFrame, RuntimeProviderPort } from "@brewva/brewva-runtime";
import { createAsyncBridge, linkAbortSignal } from "@brewva/brewva-std/async";
import { computeBackoffMs, deterministicJitterFraction } from "@brewva/brewva-std/backoff";
import { asDurable } from "@brewva/brewva-std/honesty";
import type { JsonValue } from "@brewva/brewva-std/json";
import { clamp01 } from "@brewva/brewva-std/math";
import { toErrorMessage } from "@brewva/brewva-std/unknown";
import type { BrewvaAgentProtocolAssistantMessage } from "@brewva/brewva-substrate/agent-protocol";
import type { BrewvaRegisteredModel } from "@brewva/brewva-substrate/provider";
import type {
  BrewvaModelPresetState,
  BrewvaModelRoleAlias,
} from "@brewva/brewva-substrate/session";
import {
  resolveBrewvaModelSelection,
  selectBrewvaFallbackModel,
  selectLargerContextModel,
} from "../../../policy/model-routing/api.js";
import { streamProviderMessage } from "../provider/execution-port.js";
import { isBrewvaModelRoleAlias as isHostedModelRoleAlias } from "../session/settings/model-presets.js";
import type { RateLimitBackoffSettings } from "../session/settings/settings-store.js";
import { summarizeProviderContext, toProviderContext } from "./runtime-provider-context.js";
import {
  type RuntimeAdapterSession,
  type RuntimeProviderFace,
  type RuntimeProviderProposalReceipt,
} from "./runtime-turn-session.js";

function cloneHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  return headers ? { ...headers } : undefined;
}

function toProviderModel(model: BrewvaRegisteredModel): ProviderModel<Api> {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    provider: model.provider,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    headers: cloneHeaders(model.headers),
    compat:
      model.api === "openai-completions" || model.api === "openai-responses"
        ? model.compat
        : undefined,
  };
}

function framesFromAssistantMessage(message: AssistantMessage): RuntimeProviderFrame[] {
  const frames: RuntimeProviderFrame[] = [];
  for (const part of message.content) {
    if (part.type === "text" && part.text.length > 0) {
      frames.push({ type: "text", delta: part.text });
      continue;
    }
    if (part.type === "thinking" && part.thinking.length > 0) {
      frames.push({ type: "reason", delta: part.thinking });
      continue;
    }
    if (part.type === "toolCall") {
      frames.push({
        type: "tool",
        call: {
          toolCallId: part.id,
          toolName: part.name,
          args: part.arguments,
        },
      });
    }
  }
  return frames;
}

function toTurnLoopAssistantMessage(
  message: AssistantMessage,
): BrewvaAgentProtocolAssistantMessage {
  return {
    role: "assistant",
    content: message.content.map((part) => {
      if (part.type === "text") {
        return {
          type: "text" as const,
          text: part.text,
          ...(part.textSignature ? { textSignature: part.textSignature } : {}),
        };
      }
      if (part.type === "thinking") {
        return {
          type: "thinking" as const,
          thinking: part.thinking,
          ...(part.thinkingSignature ? { thinkingSignature: part.thinkingSignature } : {}),
          ...(part.redacted !== undefined ? { redacted: part.redacted } : {}),
        };
      }
      return {
        type: "toolCall" as const,
        id: part.id,
        name: part.name,
        arguments: part.arguments,
        ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
      };
    }),
    api: message.api,
    provider: message.provider,
    model: message.model,
    ...(message.responseModel ? { responseModel: message.responseModel } : {}),
    ...(message.responseId ? { responseId: message.responseId } : {}),
    usage: {
      input: message.usage.input,
      output: message.usage.output,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
      totalTokens: message.usage.totalTokens,
      cost: { ...message.usage.cost },
    },
    stopReason: message.stopReason,
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    timestamp: message.timestamp,
  };
}

type RuntimeProviderQueueItem =
  | { readonly kind: "frame"; readonly frame: RuntimeProviderFrame }
  | { readonly kind: "done" }
  | { readonly kind: "error"; readonly error: unknown };

type ProviderFailureReason = "quota" | "rate_limit" | "auth" | "provider" | "context" | "unknown";

// Frame-state witness for the seam's hardest invariant: once any frame has
// streamed, the turn keeps this provider — no fallback, no credential rotation.
// Branding the witness makes that a type distinction the recovery path enforces,
// not a boolean a later edit can forget to check.
declare const frameWitnessBrand: unique symbol;
interface SawFrame {
  readonly frameStreamed: true;
  readonly [frameWitnessBrand]: true;
}
interface NoFrame {
  readonly frameStreamed: false;
  readonly [frameWitnessBrand]: true;
}
type FrameWitness = SawFrame | NoFrame;
const SAW_FRAME = { frameStreamed: true } as SawFrame;
const NO_FRAME = { frameStreamed: false } as NoFrame;
function frameWitness(streamed: boolean): FrameWitness {
  return streamed ? SAW_FRAME : NO_FRAME;
}

class ProviderAttemptError extends Error {
  constructor(
    readonly causeError: unknown,
    readonly frame: FrameWitness,
  ) {
    super(toErrorMessage(causeError));
    this.name = "ProviderAttemptError";
  }
}

/** One failed pre-first-frame provider attempt, as seen by the recovery loop. */
export interface ProviderFallbackAttempt {
  readonly provider: string;
  readonly model: string;
  readonly message: string;
  readonly retryable?: boolean;
}

const ATTEMPT_MESSAGE_MAX_CHARS = 200;

function truncateAttemptMessage(message: string): string {
  return message.length > ATTEMPT_MESSAGE_MAX_CHARS
    ? `${message.slice(0, ATTEMPT_MESSAGE_MAX_CHARS - 1)}…`
    : message;
}

function attemptFailureMessage(error: unknown): string {
  const message = toErrorMessage(error);
  return message.length > 0 ? message : "provider_stream_failed";
}

/**
 * The provider's structured retry classification, when it survived to this
 * error (top level or a shallow `cause` chain). Tri-state on purpose: the
 * runtime's `isRetryableProviderError` answers "may I retry?" (defaults yes),
 * while the recovery loop needs "did the provider explicitly say permanent?"
 * to remember a rejected model without guessing about unclassified failures.
 */
function readAttemptRetryable(error: unknown): boolean | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    const record = current as { retryable?: unknown; cause?: unknown };
    if (typeof record.retryable === "boolean") {
      return record.retryable;
    }
    if (record.cause === undefined || record.cause === current) {
      return undefined;
    }
    current = record.cause;
  }
  return undefined;
}

/**
 * Thrown when the recovery loop ran out of fallback candidates after MORE than
 * one attempt. The headline stays the FIRST attempt's message — that is the
 * model the user actually selected, and surfacing only the last fallback's
 * error mis-reports the failure as being about a model the user never chose.
 * The fallback trail rides in the message (self-contained across any boundary
 * that reduces errors to strings) and in `attempts` (structured, for hosts that
 * receive the object — e.g. the CLI's model-availability memory).
 */
export class ProviderFallbackExhaustedError extends Error {
  readonly retryable?: boolean;
  readonly attempts: readonly ProviderFallbackAttempt[];

  constructor(attempts: readonly ProviderFallbackAttempt[], firstCause: unknown) {
    const [first, ...rest] = attempts;
    const headline = first?.message ?? "provider_stream_failed";
    const trail = rest.map(
      (attempt) =>
        `- ${attempt.provider}/${attempt.model}: ${truncateAttemptMessage(attempt.message)}`,
    );
    super(
      [
        headline,
        "",
        `Automatic fallback tried ${rest.length} more model(s); none succeeded:`,
        ...trail,
      ].join("\n"),
      { cause: firstCause },
    );
    this.name = "ProviderFallbackExhaustedError";
    this.attempts = attempts;
    const firstRetryable = readAttemptRetryable(firstCause);
    if (firstRetryable !== undefined) {
      // Mirror the first attempt's classification at the top level so hosts
      // that only look at `error.retryable` (not the cause chain) agree with
      // the runtime's cause-walking retry gate.
      this.retryable = firstRetryable;
    }
  }
}

function modelKey(model: BrewvaRegisteredModel): string {
  return `${model.provider}/${model.id}`;
}

/**
 * HTTP-status extraction is the shared `readErrorStatus` in provider-core
 * (`contracts/error-status.ts`). Re-exported under the gateway's historical name for the
 * provider-fallback RFC and the `provider-failure-classification` test; this seam layers
 * the gateway-specific `classifyProviderStatus` taxonomy on top of the shared reader.
 */
export { readErrorStatus as readProviderErrorStatus };

/**
 * Map an unambiguous HTTP status to a failure reason. Ambiguous 4xx (e.g. 400/413,
 * which may be a context-length error) return undefined so the message regex decides.
 */
function classifyProviderStatus(status: number): ProviderFailureReason | undefined {
  if (status === 429) return "rate_limit";
  if (status === 402) return "quota";
  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status >= 500) return "provider";
  return undefined;
}

/**
 * Classify a provider failure, preferring the structured HTTP status (the most
 * reliable signal) and falling back to a message regex when no status is present.
 */
export function classifyProviderFailure(error: unknown): ProviderFailureReason {
  const status = readErrorStatus(error);
  if (status !== undefined) {
    const byStatus = classifyProviderStatus(status);
    if (byStatus !== undefined) {
      return byStatus;
    }
  }
  const message = toErrorMessage(error).toLowerCase();
  if (/\b(quota|insufficient_quota|billing)\b/u.test(message)) return "quota";
  if (/\b(rate.?limit|429|too many requests)\b/u.test(message)) return "rate_limit";
  if (/\b(auth|api key|unauthorized|forbidden|401|403)\b/u.test(message)) return "auth";
  if (
    /\b(context|tokens?|too long)\b/u.test(message) ||
    /maximum allowed input length|maximum context|context length|maximum .*input length|exceeds .*maximum .*context length/u.test(
      message,
    )
  ) {
    return "context";
  }
  if (/\b(provider|upstream|service unavailable|overloaded|timeout|temporar)\b/u.test(message)) {
    return "provider";
  }
  return "unknown";
}

// Recovery (credential rotation, model fallback) is reachable only with proof that
// no frame streamed. The `NoFrame` parameter makes bypassing the pre-first-frame
// boundary a compile error rather than a comment to remember.
function classifyRecoverableFailure(
  error: ProviderAttemptError,
  _frame: NoFrame,
): ProviderFailureReason {
  return classifyProviderFailure(error.causeError);
}

function credentialRotationReason(
  reason: ProviderFailureReason,
): "quota" | "rate_limit" | "auth" | undefined {
  if (reason === "quota" || reason === "rate_limit" || reason === "auth") {
    return reason;
  }
  return undefined;
}

/**
 * The delay (ms) for the `used`-th same-model backoff retry of a `rate_limit`, or
 * undefined when backoff is off (`maxRetries <= 0`) or exhausted. Exponential from
 * `baseDelayMs`, capped at `maxDelayMs`, then full-jittered: the return is sampled in
 * `[0, ceiling)` via the caller-supplied `jitterFraction` so a herd of turns that hit
 * the same 429 at once retries on decorrelated schedules instead of locking step on one
 * wake time — the thundering-herd guard the scheduler already applies to recurring
 * slots, here keyed per `(session, attempt)`. Pure, so the policy is unit-testable; the
 * deterministic FNV fraction lives in the caller.
 */
export function nextRateLimitBackoffMs(
  used: number,
  config: RateLimitBackoffSettings | undefined,
  jitterFraction: number,
): number | undefined {
  if (!config || config.maxRetries <= 0 || used >= config.maxRetries) {
    return undefined;
  }
  const ceiling = computeBackoffMs(used, {
    baseMs: config.baseDelayMs,
    factor: 2,
    maxMs: config.maxDelayMs,
  });
  const fraction = Number.isFinite(jitterFraction) ? clamp01(jitterFraction) : 0;
  return Math.floor(fraction * ceiling);
}

/** Resolve after `ms`, or immediately to `false` if the turn aborts during the wait. */
function sleepWithAbort(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted === true) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer) {
        clearTimeout(timer);
      }
      resolve(false);
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function activePresetFromFace(
  face: RuntimeProviderFace,
): BrewvaModelPresetState["presets"][number] | undefined {
  const state = face.getModelPresetState();
  return state.presets.find((preset) => preset.name === state.activeName);
}

function resolveModelText(
  face: RuntimeProviderFace,
  modelText: string,
): BrewvaRegisteredModel | undefined {
  const catalog = face.getModelCatalog();
  const selection = resolveBrewvaModelSelection(modelText, {
    getAll: () => [...catalog.getAll()],
  });
  return selection.model;
}

function fallbackCandidates(input: {
  face: RuntimeProviderFace;
  currentModel: BrewvaRegisteredModel;
  attemptedModelKeys: ReadonlySet<string>;
  activeRole: BrewvaModelRoleAlias;
}): BrewvaRegisteredModel[] {
  const catalog = input.face.getModelCatalog();
  const availableModels = catalog.getAll();
  const settings = input.face.getModelRoutingSettings();
  const activePreset = activePresetFromFace(input.face);
  // Everything a fallback must not re-dial: this turn's attempts, plus models
  // the session already saw the provider reject permanently (entitlement,
  // revoked credential). The exclusion feeds the affinity selector itself —
  // filtering its single top pick after the fact would read as exhaustion
  // while viable lower-ranked candidates remain.
  const excludedModelKeys = new Set<string>([
    modelKey(input.currentModel),
    ...input.attemptedModelKeys,
    ...(input.face.getUnavailableProviderModels?.()?.keys() ?? []),
    // Models still cooling from a recent rate-limit / quota wall: excluded from
    // fallback selection so recovery does not immediately re-dial one, mirroring
    // the pre-ranking exclusion above (filtering the single top pick post-hoc
    // would read as exhaustion while viable candidates remain).
    ...(input.face.getSuppressedSelectors?.(Date.now())?.keys() ?? []),
  ]);
  const candidates: BrewvaRegisteredModel[] = [];
  const push = (model: BrewvaRegisteredModel | undefined) => {
    if (!model) return;
    const key = modelKey(model);
    if (excludedModelKeys.has(key)) return;
    if (candidates.some((candidate) => modelKey(candidate) === key)) return;
    candidates.push(model);
  };
  const chain =
    settings?.fallbackChains[input.activeRole] ?? settings?.fallbackChains.default ?? [];
  for (const entry of chain) {
    const modelText = isHostedModelRoleAlias(entry) ? activePreset?.roles[entry] : entry;
    if (modelText) {
      push(resolveModelText(input.face, modelText));
    }
  }
  if (availableModels.length > 0) {
    push(
      selectBrewvaFallbackModel({
        currentModel: input.currentModel,
        availableModels,
        excludeModelKeys: excludedModelKeys,
      }),
    );
  }
  return candidates;
}

function providerFallbackMetadata(input: {
  active: boolean;
  attemptedModel: BrewvaRegisteredModel;
  selectedModel: BrewvaRegisteredModel;
  reason: ProviderFailureReason;
  errorSummary?: string;
  cacheInvalidated?: boolean;
  credentialSlot?: string;
}): Record<string, JsonValue> {
  return {
    active: input.active,
    attemptedRoute: {
      provider: input.attemptedModel.provider,
      model: input.attemptedModel.id,
    },
    selectedRoute: {
      provider: input.selectedModel.provider,
      model: input.selectedModel.id,
      ...(input.credentialSlot ? { credentialSlot: input.credentialSlot } : {}),
    },
    reason: input.reason,
    // The failed attempt's message (truncated). `reason` is the coarse
    // classification; without the text, a drift sample reading `unknown`
    // leaves the tape unable to answer WHY a route was abandoned.
    ...(input.errorSummary ? { errorSummary: input.errorSummary } : {}),
    revertPolicy: "next_turn_uses_active_preset_or_explicit_selection",
    cache_invalidated:
      input.cacheInvalidated ??
      (input.attemptedModel.provider !== input.selectedModel.provider ||
        input.attemptedModel.id !== input.selectedModel.id),
  };
}

function frameFromProviderEvent(event: AssistantMessageEvent): RuntimeProviderFrame | null {
  if (event.type === "text_delta" && event.delta.length > 0) {
    return { type: "text", delta: event.delta };
  }
  if (event.type === "thinking_delta" && event.delta.length > 0) {
    return { type: "reason", delta: event.delta };
  }
  if (event.type === "toolcall_end") {
    return {
      type: "tool",
      call: {
        toolCallId: event.toolCall.id,
        toolName: event.toolCall.name,
        args: event.toolCall.arguments,
      },
    };
  }
  return null;
}

// Project the attempt-local receipt onto the canonical tool proposal. The manifest
// id stays an audit correlation; the per-tool identity hash is the execution-bearing
// fact persisted by `tool.proposed`. A tool absent from the receipt carries only the
// manifest id so the executor can reject it as unadvertised.
function stampProposalReceipt(
  frame: RuntimeProviderFrame,
  receipt: RuntimeProviderProposalReceipt | undefined,
): RuntimeProviderFrame {
  if (frame.type !== "tool") {
    return frame;
  }
  if (receipt === undefined) {
    throw new Error("hosted_runtime_provider_missing_proposal_receipt");
  }
  const identityHash = receipt.perToolIdentity.find(
    (entry) => entry.name === frame.call.toolName,
  )?.identityHash;
  return {
    ...frame,
    call: {
      ...frame.call,
      proposalManifestId: receipt.manifestId,
      ...(identityHash ? { proposalToolIdentityHash: identityHash } : {}),
    },
  };
}

async function* streamRuntimeProviderAttempt(
  session: RuntimeAdapterSession,
  face: RuntimeProviderFace,
  input: Parameters<RuntimeProviderPort["stream"]>[0],
  model: BrewvaRegisteredModel,
  providerFallback: Record<string, JsonValue> | undefined,
): AsyncGenerator<RuntimeProviderFrame> {
  // Record the fallback ROUTE SELECTION before resolving auth, so a selected-but-
  // never-dispatched fallback (auth failing on the fallback route) still leaves a drift
  // sample. Dispatch-time fingerprinting stays in the payload pipeline.
  if (providerFallback) {
    face.recordProviderFallbackSelection({ providerFallback, turnId: input.turn.turnId });
  }
  const resolvedAuth = await face.getModelCatalog().getApiKeyAndHeaders(model);
  if (!resolvedAuth.ok) {
    throw new ProviderAttemptError(
      new Error(`hosted_runtime_provider_auth_failed:${resolvedAuth.error}`),
      NO_FRAME,
    );
  }
  const providerAbort = new AbortController();
  const unlinkAbort = linkAbortSignal(input.turn.signal, providerAbort);
  const providerContext = toProviderContext(session, input);
  const providerContextSummary = summarizeProviderContext(providerContext);
  let attemptProposalReceipt: RuntimeProviderProposalReceipt | undefined;
  const options: ProviderStreamOptions = {
    signal: providerAbort.signal,
    apiKey: resolvedAuth.apiKey,
    headers: cloneHeaders(resolvedAuth.headers),
    sessionId: input.turn.sessionId,
    cachePolicy: face.getProviderCachePolicy(),
    transport: face.getProviderTransport(),
    ...(providerFallback ? { metadata: { providerFallback } } : {}),
    onPayload: async (payload, providerModel, metadata) => {
      const prepared = await face.prepareProviderPayload({
        payload,
        model: providerModel,
        metadata,
        transmittedSecrets: resolvedAuth.apiKey ? [resolvedAuth.apiKey] : [],
        turn: {
          sessionId: input.turn.sessionId,
          ...(input.turn.turnId ? { turnId: input.turn.turnId } : {}),
        },
        providerContext: providerContextSummary,
      });
      attemptProposalReceipt = prepared.proposalReceipt;
      return prepared.payload;
    },
    onCacheRender: (render, providerModel) =>
      face.observeCacheRender({
        render,
        model: providerModel,
      }),
  };
  const providerStream = streamProviderMessage(toProviderModel(model), providerContext, options);
  let sawIncrementalFrame = false;
  const bridge = createAsyncBridge<RuntimeProviderQueueItem>({
    onCancel() {
      providerAbort.abort();
    },
  });
  const consume = runBoundaryOperation(
    "gateway.hosted.provider.consume",
    providerStream.pipe(
      BrewvaStream.runForEach((event) =>
        BrewvaEffect.promise(async () => {
          if (event.type === "error") {
            face.observeAssistantMessage(toTurnLoopAssistantMessage(event.error));
            const reconstructed = new Error(event.error.errorMessage ?? "provider_stream_failed");
            if (event.retryable !== undefined) {
              // Carry the provider's retry classification across the bridge so the
              // runtime fails fast on a permanent error instead of retrying it.
              (reconstructed as { retryable?: boolean }).retryable = event.retryable;
            }
            await bridge.write({
              kind: "error",
              error: new ProviderAttemptError(reconstructed, frameWitness(sawIncrementalFrame)),
            });
            return;
          }
          const frame = frameFromProviderEvent(event);
          if (frame) {
            sawIncrementalFrame = true;
            await bridge.write({ kind: "frame", frame });
            return;
          }
          if (event.type === "done") {
            face.observeAssistantMessage(toTurnLoopAssistantMessage(event.message));
            if (!sawIncrementalFrame) {
              for (const fallback of framesFromAssistantMessage(event.message)) {
                await bridge.write({ kind: "frame", frame: fallback });
              }
            }
          }
        }),
      ),
      BrewvaEffect.provide(providerRuntimeLayer),
    ),
    { signal: providerAbort.signal },
  )
    .then(() => bridge.write({ kind: "done" }))
    .then(() => {
      bridge.close();
    })
    .catch((error) =>
      bridge.fail(new ProviderAttemptError(error, frameWitness(sawIncrementalFrame))),
    );

  try {
    for await (const next of bridge) {
      if (next.kind === "frame") {
        yield stampProposalReceipt(next.frame, attemptProposalReceipt);
        continue;
      }
      if (next.kind === "error") {
        throw next.error;
      }
      break;
    }
  } finally {
    providerAbort.abort();
    unlinkAbort();
    bridge.close();
    void consume.catch(() => undefined);
  }
}

export function createHostedRuntimeProviderPort(
  session: RuntimeAdapterSession,
  face: RuntimeProviderFace,
): RuntimeProviderPort {
  return {
    async *stream(input) {
      const initialModel = face.model;
      if (!initialModel) {
        throw new Error("hosted_runtime_provider_missing_model");
      }
      const activeRole = face.getActiveModelRole();
      let activeModel = initialModel;
      let fallbackMetadata: Record<string, JsonValue> | undefined;
      const attempted = new Set<string>();
      // Cross-turn cooldown skip: the active model is re-seeded from the preset
      // every turn, so if the preset primary is still cooling from a recent
      // rate-limit / quota wall, start on a non-suppressed fallback instead of
      // paying a wasted failed request re-dialing it during the outage window.
      // If nothing viable is un-suppressed, dial the primary anyway (a cooling
      // model beats no model). Proactive routing, not a failure — deliberately
      // not drift-sampled; the abandonment that set the cooldown was already
      // sampled on its own turn, and the response manifest records the model
      // actually used.
      const suppressedAtStart = face.getSuppressedSelectors?.(Date.now());
      if (suppressedAtStart && suppressedAtStart.has(modelKey(activeModel))) {
        const [warmStart] = fallbackCandidates({
          face,
          currentModel: activeModel,
          attemptedModelKeys: new Set([modelKey(activeModel)]),
          activeRole,
        });
        if (warmStart) {
          activeModel = warmStart;
        }
      }
      // Final failure per route, in attempt order. Same-model retries (credential
      // rotation, rate-limit backoff) overwrite their entry rather than append, so
      // an exhaustion report reads one line per route.
      const attemptTrail: ProviderFallbackAttempt[] = [];
      let firstAttemptCause: unknown;
      const rotatedSlotsByModel = new Map<string, Set<string>>();
      const backoffByModel = new Map<string, number>();
      while (true) {
        attempted.add(modelKey(activeModel));
        try {
          yield* streamRuntimeProviderAttempt(session, face, input, activeModel, fallbackMetadata);
          return;
        } catch (error) {
          const attemptError =
            error instanceof ProviderAttemptError
              ? error
              : new ProviderAttemptError(error, NO_FRAME);
          if (attemptError.frame.frameStreamed) {
            throw attemptError.causeError;
          }
          if (input.turn.signal?.aborted === true) {
            throw attemptError.causeError;
          }
          const reason = classifyRecoverableFailure(attemptError, attemptError.frame);
          const attemptMessage = attemptFailureMessage(attemptError.causeError);
          const attemptSummary = truncateAttemptMessage(attemptMessage);
          if (firstAttemptCause === undefined) {
            firstAttemptCause = attemptError.causeError;
          }
          // One read of the routing settings per recovery attempt, shared by credential
          // rotation and the rate-limit backoff below.
          const routingSettings = face.getModelRoutingSettings();
          // Overall retry ceiling: caps how long a single recovery step may block
          // before preferring a model switch (or failure) over sleeping.
          const retryMaxDelayMs = face.getRetrySettings?.()?.maxDelayMs;
          const rotationReason = credentialRotationReason(reason);
          const rotationSettings = routingSettings?.credentialRotation;
          if (rotationReason && rotationSettings?.enabled === true) {
            const rotation = face
              .getModelCatalog()
              .rotateCredential?.(
                activeModel.provider,
                rotationReason,
                rotationSettings.cooldownMs,
              );
            if (rotation) {
              const rotatedSlots =
                rotatedSlotsByModel.get(modelKey(activeModel)) ?? new Set<string>();
              // Each (model, slot) rotates at most once per turn; a repeat means the
              // slots are ping-ponging (cooldownMs=0 with persistently failing creds), so
              // stop rotating and fall through to model fallback below instead of looping.
              if (!rotatedSlots.has(rotation.credentialSlot)) {
                rotatedSlots.add(rotation.credentialSlot);
                rotatedSlotsByModel.set(modelKey(activeModel), rotatedSlots);
                face.recordProviderCredentialRotated(asDurable(rotation));
                fallbackMetadata = providerFallbackMetadata({
                  active: true,
                  attemptedModel: activeModel,
                  selectedModel: activeModel,
                  reason,
                  errorSummary: attemptSummary,
                  cacheInvalidated: true,
                  credentialSlot: rotation.credentialSlot,
                });
                continue;
              }
            }
          }
          // A transient rate_limit that could not be rotated may, if the operator opted
          // in, cool off and retry the SAME model before downgrading. The retry is
          // transparent (same model + credential), so it leaves `fallbackMetadata`
          // untouched — it is not a fallback selection and must not be drift-sampled as
          // one. Pre-first-frame (the `NoFrame` proof above) and abort-aware. The delay
          // is full-jittered per (session, attempt) so concurrent turns rate-limited at
          // once do not retry in lock-step. A 429's `Retry-After` header is deliberately
          // not consulted: this path is shared with the in-band error-event path, which
          // is already reduced to a message string with no headers, so one computed
          // schedule serves both rather than a header-or-formula split.
          if (reason === "rate_limit") {
            const used = backoffByModel.get(modelKey(activeModel)) ?? 0;
            const backoffMs = nextRateLimitBackoffMs(
              used,
              routingSettings?.rateLimitBackoff,
              deterministicJitterFraction(`${input.turn.sessionId}:${used}`),
            );
            // Fail-fast cap: when the computed wait exceeds the overall retry
            // ceiling, do NOT sleep — fall through to model fallback below. If a
            // fallback model exists we switch to it; if none does, the error
            // surfaces instead of the turn blocking for `backoffMs`. brewva does
            // not honor `Retry-After`, so today `backoffMs` is already bounded by
            // `rateLimitBackoff.maxDelayMs`; this is the cross-path ceiling (and
            // the guard should header honoring ever be added).
            const withinCap =
              retryMaxDelayMs === undefined ||
              retryMaxDelayMs <= 0 ||
              backoffMs === undefined ||
              backoffMs <= retryMaxDelayMs;
            if (backoffMs !== undefined && withinCap) {
              if (!(await sleepWithAbort(backoffMs, input.turn.signal))) {
                throw attemptError.causeError;
              }
              backoffByModel.set(modelKey(activeModel), used + 1);
              continue;
            }
          }
          // The route's failure is final for this turn (rotation and same-model
          // backoff both `continue` above): record it on the trail, and remember a
          // provider-classified PERMANENT rejection (`retryable: false`) for the
          // session so later fallbacks stop re-dialing a model the account cannot
          // use. Unclassified failures are not remembered — a transient outage
          // must not brand a model unavailable.
          const attemptRetryable = readAttemptRetryable(attemptError.causeError);
          const attemptRecord: ProviderFallbackAttempt = {
            provider: activeModel.provider,
            model: activeModel.id,
            message: attemptMessage,
            ...(attemptRetryable !== undefined ? { retryable: attemptRetryable } : {}),
          };
          const lastAttempt = attemptTrail.at(-1);
          if (
            lastAttempt?.provider === attemptRecord.provider &&
            lastAttempt.model === attemptRecord.model
          ) {
            attemptTrail[attemptTrail.length - 1] = attemptRecord;
          } else {
            attemptTrail.push(attemptRecord);
          }
          if (attemptRetryable === false) {
            face.markProviderModelUnavailable?.({
              provider: activeModel.provider,
              modelId: activeModel.id,
              reason: attemptSummary,
            });
          }
          // Cool down a model that hit a transient rate-limit / quota wall so the
          // next turn's start skips re-dialing it during the outage window.
          // Bundled with rate-limit backoff: active only when the operator
          // configured backoff (`maxRetries > 0`), reusing its `maxDelayMs` as the
          // cooldown window, so the default (backoff off) behavior is unchanged.
          const backoffSettings = routingSettings?.rateLimitBackoff;
          const cooldownMs =
            backoffSettings && backoffSettings.maxRetries > 0 ? backoffSettings.maxDelayMs : 0;
          if (cooldownMs > 0 && (reason === "rate_limit" || reason === "quota")) {
            face.suppressSelector?.(modelKey(activeModel), Date.now() + cooldownMs);
          }
          // Context overflow: promote to a strictly-larger-context model before
          // falling back to a generic (possibly smaller) model or compacting.
          // Pre-first-frame (`NoFrame`), so this is request-time recovery, not a
          // mid-stream switch. The configured fallback chain is hard priority
          // (per the model-fallback-replay-visible solution: role chain → default
          // chain): prefer the first chain candidate whose context window is
          // strictly larger — a smaller one would just re-overflow — and only if
          // the chain offers nothing larger fall to the heuristic same-provider
          // larger sibling. Promotion therefore never bypasses an operator-
          // approved route. Bounded by `attempted`: a repeated overflow excludes
          // the promoted model and picks a yet-larger one, or none.
          if (reason === "context") {
            const chainCandidates = fallbackCandidates({
              face,
              currentModel: activeModel,
              attemptedModelKeys: attempted,
              activeRole,
            });
            const promoted =
              chainCandidates.find(
                (candidate) => candidate.contextWindow > activeModel.contextWindow,
              ) ??
              selectLargerContextModel({
                currentModel: activeModel,
                availableModels: face.getModelCatalog().getAll(),
                excludeModelKeys: new Set<string>([
                  modelKey(activeModel),
                  ...attempted,
                  ...(face.getUnavailableProviderModels?.()?.keys() ?? []),
                  ...(face.getSuppressedSelectors?.(Date.now())?.keys() ?? []),
                ]),
              });
            if (promoted) {
              fallbackMetadata = providerFallbackMetadata({
                active: true,
                attemptedModel: activeModel,
                selectedModel: promoted,
                reason,
                errorSummary: attemptSummary,
              });
              activeModel = promoted;
              continue;
            }
          }
          const [nextModel] = fallbackCandidates({
            face,
            currentModel: activeModel,
            attemptedModelKeys: attempted,
            activeRole,
          });
          if (!nextModel) {
            // Exhausted after at least one fallback: surface the FIRST attempt's
            // error (the model the user selected) with the full trail, instead of
            // masking it behind whichever fallback happened to fail last.
            if (attemptTrail.length > 1) {
              throw new ProviderFallbackExhaustedError(attemptTrail, firstAttemptCause);
            }
            throw attemptError.causeError;
          }
          fallbackMetadata = providerFallbackMetadata({
            active: true,
            attemptedModel: activeModel,
            selectedModel: nextModel,
            reason,
            errorSummary: attemptSummary,
          });
          activeModel = nextModel;
        }
      }
    },
  };
}
