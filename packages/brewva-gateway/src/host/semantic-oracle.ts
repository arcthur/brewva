import { createHash } from "node:crypto";
import {
  SEMANTIC_EXTRACTION_INVOKED_EVENT_TYPE,
  SEMANTIC_RERANK_INVOKED_EVENT_TYPE,
  recordAssistantUsageFromMessage,
  type BrewvaRuntime,
} from "@brewva/brewva-runtime";
import type {
  BrewvaSemanticOracle,
  SemanticOracleNarrativeExtractionInput,
  SemanticOracleNarrativeExtractionResult,
  SemanticOracleRerankInput,
  SemanticOracleRerankResult,
} from "@brewva/brewva-tools";
import { complete, type Message } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

type RegisteredModel = NonNullable<ReturnType<ModelRegistry["getAll"]>[number]>;

interface HostedSemanticOracleOptions {
  model?: RegisteredModel;
  modelRegistry: Pick<ModelRegistry, "getApiKeyAndHeaders">;
  runtime: Pick<BrewvaRuntime, "cost" | "events">;
  completeFn?: typeof complete;
}

type SemanticCompletionOutcome = "completed" | "error" | "unavailable";
type SemanticInvocationOutcome =
  | "accepted"
  | "cached"
  | "error"
  | "rejected"
  | "reranked"
  | "unavailable";

interface SemanticJsonCompletion {
  parsed: unknown;
  outcome: SemanticCompletionOutcome;
  modelRef?: string;
  response?: unknown;
}

function compactText(value: string, maxChars = 400): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 3))}...`;
}

function resolveLocalDateStamp(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year") ?? "0000"}-${byType.get("month") ?? "00"}-${byType.get("day") ?? "00"}`;
}

function resolveModelRef(model: RegisteredModel | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

function buildCacheKey(label: string, payload: unknown): string {
  return createHash("sha256")
    .update(label)
    .update("\n")
    .update(JSON.stringify(payload))
    .digest("hex");
}

function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) =>
      item && typeof item === "object" && (item as { type?: unknown }).type === "text"
        ? (item as { text?: unknown }).text
        : "",
    )
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .trim();
}

function tryParseJson(text: string): unknown {
  const normalized = text.trim();
  if (!normalized) {
    return undefined;
  }
  try {
    return JSON.parse(normalized);
  } catch {
    const fenced = normalized.match(/```(?:json)?\s*([\s\S]+?)\s*```/u);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        return undefined;
      }
    }
    const firstBrace = normalized.indexOf("{");
    const lastBrace = normalized.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(normalized.slice(firstBrace, lastBrace + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

class HostedSemanticOracle implements BrewvaSemanticOracle {
  private readonly rerankCache = new Map<string, SemanticOracleRerankResult>();

  constructor(private readonly options: HostedSemanticOracleOptions) {}

  async rerankNarrativeMemory(
    input: SemanticOracleRerankInput,
  ): Promise<SemanticOracleRerankResult | null> {
    return this.rerank(input);
  }

  async rerankDeliberationMemory(
    input: SemanticOracleRerankInput,
  ): Promise<SemanticOracleRerankResult | null> {
    return this.rerank(input);
  }

  async extractNarrativeMemoryCandidate(
    input: SemanticOracleNarrativeExtractionInput,
  ): Promise<SemanticOracleNarrativeExtractionResult | null> {
    const todayLocalDate = resolveLocalDateStamp();
    const completion = await this.completeJson({
      systemPrompt: [
        "You classify whether a user turn contains durable, non-authoritative narrative memory.",
        "Prefer reject when the signal is ambiguous, transient, or only useful for the current task.",
        "Only accept future-useful collaboration semantics that are not derivable from code, git, task truth, ledger truth, approval truth, or precedent documents.",
        "Reject transient plans, task closure, acceptance facts, verification facts, code facts, git facts, and docs/solutions-style precedent.",
        "Capture validated positive feedback as well as corrections when they establish a reusable collaboration rule.",
        "For operator_preference and working_convention, preserve the rule itself and include 'Why:' and 'How to apply:' lines when the turn supports them.",
        "For project_context_note, preserve the motivating context and normalize relative dates like today, tomorrow, or Thursday into explicit ISO dates using the provided today_local_date value.",
        "For external_reference_note, store where to look and why it matters, not a copied activity log.",
        "Return strict JSON with keys: accept:boolean, record?:{class,title,summary,content,applicabilityScope,confidenceScore}.",
      ].join(" "),
      userText: [
        `session_id=${input.sessionId}`,
        `agent_id=${input.agentId}`,
        `today_local_date=${todayLocalDate}`,
        `target_roots=${input.targetRoots.join(", ") || "none"}`,
        "",
        "## User Text",
        compactText(input.userText, 2_400),
        "",
        "## Tool Evidence",
        input.toolEvidence.length > 0
          ? input.toolEvidence
              .slice(0, 6)
              .map(
                (entry) =>
                  `- tool=${entry.toolName} error=${entry.isError ? "yes" : "no"} summary=${compactText(entry.summary, 240)}`,
              )
              .join("\n")
          : "none",
      ].join("\n"),
      sessionId: input.sessionId,
    });

    const response = completion.parsed;
    let outcome: SemanticInvocationOutcome =
      completion.outcome === "completed" ? "rejected" : completion.outcome;
    let extracted: SemanticOracleNarrativeExtractionResult | null = null;

    if (isRecord(response) && response.accept === true && isRecord(response.record)) {
      const record = response.record;
      const recordClass = readString(record.class);
      const title = readString(record.title);
      const summary = readString(record.summary);
      const content = readString(record.content);
      const applicabilityScope = readString(record.applicabilityScope);
      const confidenceScore =
        typeof record.confidenceScore === "number" && Number.isFinite(record.confidenceScore)
          ? Math.max(0, Math.min(1, record.confidenceScore))
          : undefined;
      if (
        recordClass &&
        title &&
        summary &&
        content &&
        applicabilityScope &&
        confidenceScore !== undefined &&
        (recordClass === "operator_preference" ||
          recordClass === "working_convention" ||
          recordClass === "project_context_note" ||
          recordClass === "external_reference_note") &&
        (applicabilityScope === "operator" ||
          applicabilityScope === "agent" ||
          applicabilityScope === "repository")
      ) {
        extracted = {
          class: recordClass,
          title,
          summary,
          content,
          applicabilityScope,
          confidenceScore,
        };
        outcome = "accepted";
      }
    }

    this.recordExtractionEvent(input, {
      outcome,
      modelRef: completion.modelRef,
      recordClass: extracted?.class ?? null,
    });
    return extracted;
  }

  private async rerank(
    input: SemanticOracleRerankInput,
  ): Promise<SemanticOracleRerankResult | null> {
    if (input.candidates.length < 2) {
      return null;
    }
    const cacheKey = buildCacheKey("semantic-rerank", {
      surface: input.surface,
      query: input.query,
      targetRoots: input.targetRoots,
      stateRevision: input.stateRevision,
      candidates: input.candidates.map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        summary: candidate.summary,
        kind: candidate.kind ?? null,
        scope: candidate.scope ?? null,
      })),
    });
    const cached = this.rerankCache.get(cacheKey);
    if (cached) {
      const result = {
        ...cached,
        cached: true,
      };
      this.recordRerankEvent(input, {
        outcome: "cached",
        cacheKey,
        cached: true,
        modelRef: result.modelRef,
        orderedIds: result.orderedIds,
      });
      return result;
    }

    const completion = await this.completeJson({
      systemPrompt: [
        "You rerank bounded memory candidates for immediate relevance.",
        "Return strict JSON with one key: ordered_ids, an array containing only candidate ids.",
        "Do not invent ids, do not explain, do not include markdown.",
      ].join(" "),
      userText: [
        `surface=${input.surface}`,
        `state_revision=${input.stateRevision}`,
        `target_roots=${input.targetRoots.join(", ") || "none"}`,
        "",
        "## Query",
        compactText(input.query, 1_200),
        "",
        "## Candidates",
        input.candidates
          .slice(0, 12)
          .map((candidate) =>
            [
              `id=${candidate.id}`,
              `title=${compactText(candidate.title, 120)}`,
              `summary=${compactText(candidate.summary, 220)}`,
              `content=${compactText(candidate.content, 320)}`,
              candidate.kind ? `kind=${candidate.kind}` : null,
              candidate.scope ? `scope=${candidate.scope}` : null,
            ]
              .filter(Boolean)
              .join("\n"),
          )
          .join("\n\n"),
      ].join("\n"),
      sessionId: input.sessionId,
    });
    const response = completion.parsed;
    if (!isRecord(response) || !Array.isArray(response.ordered_ids)) {
      this.recordRerankEvent(input, {
        outcome: completion.outcome === "completed" ? "rejected" : completion.outcome,
        cacheKey,
        cached: false,
        modelRef: completion.modelRef,
        orderedIds: [],
      });
      return null;
    }
    const candidateIds = new Set(input.candidates.map((candidate) => candidate.id));
    const orderedIds = response.ordered_ids
      .map((value) => readString(value))
      .filter((value): value is string => typeof value === "string" && candidateIds.has(value));
    if (orderedIds.length === 0) {
      this.recordRerankEvent(input, {
        outcome: completion.outcome === "completed" ? "rejected" : completion.outcome,
        cacheKey,
        cached: false,
        modelRef: completion.modelRef,
        orderedIds: [],
      });
      return null;
    }

    const result: SemanticOracleRerankResult = {
      orderedIds,
      cacheKey,
      modelRef: completion.modelRef,
      cached: false,
    };
    this.rerankCache.set(cacheKey, result);
    this.recordRerankEvent(input, {
      outcome: "reranked",
      cacheKey,
      cached: false,
      modelRef: result.modelRef,
      orderedIds: result.orderedIds,
    });
    return result;
  }

  private recordExtractionEvent(
    input: SemanticOracleNarrativeExtractionInput,
    audit: {
      outcome: SemanticInvocationOutcome;
      modelRef?: string;
      recordClass: string | null;
    },
  ): void {
    this.options.runtime.events.record({
      sessionId: input.sessionId,
      type: SEMANTIC_EXTRACTION_INVOKED_EVENT_TYPE,
      payload: {
        surface: "narrative_memory",
        outcome: audit.outcome,
        modelRef: audit.modelRef ?? null,
        targetRoots: [...input.targetRoots],
        accepted: audit.outcome === "accepted",
        recordClass: audit.recordClass,
      },
    });
  }

  private recordRerankEvent(
    input: SemanticOracleRerankInput,
    audit: {
      outcome: SemanticInvocationOutcome;
      cacheKey: string;
      cached: boolean;
      modelRef?: string;
      orderedIds: readonly string[];
    },
  ): void {
    this.options.runtime.events.record({
      sessionId: input.sessionId,
      type: SEMANTIC_RERANK_INVOKED_EVENT_TYPE,
      payload: {
        surface: input.surface,
        query: input.query,
        stateRevision: input.stateRevision,
        targetRoots: [...input.targetRoots],
        candidateIds: input.candidates.map((candidate) => candidate.id),
        orderedIds: [...audit.orderedIds],
        modelRef: audit.modelRef ?? null,
        cached: audit.cached,
        cacheKey: audit.cacheKey,
        outcome: audit.outcome,
      },
    });
  }

  private async completeJson(input: {
    systemPrompt: string;
    userText: string;
    sessionId: string;
  }): Promise<SemanticJsonCompletion> {
    const model = this.options.model;
    if (!model) {
      return {
        parsed: null,
        outcome: "unavailable",
      };
    }

    const modelRef = resolveModelRef(model);
    const auth = await this.options.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      return {
        parsed: null,
        outcome: "unavailable",
        modelRef,
      };
    }

    const userMessage: Message = {
      role: "user",
      content: [{ type: "text", text: input.userText }],
      timestamp: Date.now(),
    };

    try {
      const response = await (this.options.completeFn ?? complete)(
        model,
        {
          systemPrompt: input.systemPrompt,
          messages: [userMessage],
        },
        { apiKey: auth.apiKey, headers: auth.headers },
      );
      recordAssistantUsageFromMessage(this.options.runtime, input.sessionId, response);
      return {
        parsed: tryParseJson(extractTextContent(response.content)),
        outcome: "completed",
        modelRef,
        response,
      };
    } catch {
      return {
        parsed: null,
        outcome: "error",
        modelRef,
      };
    }
  }
}

export function createHostedSemanticOracle(
  options: HostedSemanticOracleOptions,
): BrewvaSemanticOracle {
  return new HostedSemanticOracle(options);
}
