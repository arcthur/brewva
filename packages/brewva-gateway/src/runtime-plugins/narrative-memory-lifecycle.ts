import {
  getOrCreateNarrativeMemoryPlane,
  validateNarrativeMemoryCandidate,
} from "@brewva/brewva-deliberation";
import { NARRATIVE_MEMORY_RECORDED_EVENT_TYPE, type BrewvaRuntime } from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import type { BrewvaSemanticReranker } from "@brewva/brewva-tools";
import type { TurnLifecyclePort } from "./turn-lifecycle-port.js";

interface ToolEvidenceEntry {
  toolName: string;
  summary: string;
  isError: boolean;
}

interface NarrativeTurnScratch {
  inputTexts: string[];
  toolEvidence: ToolEvidenceEntry[];
  explicitMutationCommitted: boolean;
}

function getSessionId(ctx: { sessionManager?: { getSessionId?: () => string } }): string {
  return ctx.sessionManager?.getSessionId?.() ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function compactText(value: string, maxChars = 260): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 3))}...`;
}

function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
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

function normalizeScratch(
  store: Map<string, NarrativeTurnScratch>,
  sessionId: string,
): NarrativeTurnScratch {
  const existing = store.get(sessionId);
  if (existing) {
    return existing;
  }
  const created: NarrativeTurnScratch = {
    inputTexts: [],
    toolEvidence: [],
    explicitMutationCommitted: false,
  };
  store.set(sessionId, created);
  return created;
}

function hasNarrativeSignal(text: string): boolean {
  return (
    /(?:remember|note(?:\s+that)?|prefer|always|avoid|do not|don't|for this repo|for this project|dashboard|runbook|reference|link)/iu.test(
      text,
    ) ||
    hasValidatedPositiveFeedbackSignal(text) ||
    hasRelativeDateSignal(text)
  );
}

function inferDeterministicCandidate(input: { text: string }): {
  class:
    | "operator_preference"
    | "working_convention"
    | "project_context_note"
    | "external_reference_note";
  title: string;
  summary: string;
  content: string;
  applicabilityScope: "operator" | "agent" | "repository";
  confidenceScore: number;
} | null {
  const normalized = input.text.replace(/\s+/g, " ").trim();
  if (!normalized || !hasNarrativeSignal(normalized)) {
    return null;
  }

  const urlMatch = normalized.match(/https?:\/\/\S+/iu);
  if (urlMatch) {
    return {
      class: "external_reference_note",
      title: "Reusable External Reference",
      summary: compactText(normalized, 160),
      content: normalized,
      applicabilityScope: "repository",
      confidenceScore: 0.74,
    };
  }

  if (/(?:i prefer|please|my preference|avoid|don't|do not)/iu.test(normalized)) {
    return {
      class: "operator_preference",
      title: "Operator Preference",
      summary: compactText(normalized, 160),
      content: normalized,
      applicabilityScope: "operator",
      confidenceScore: 0.78,
    };
  }

  if (
    /(?:for this repo|for this project|we use|we prefer|always use|note that)/iu.test(normalized)
  ) {
    return {
      class: "working_convention",
      title: "Working Convention",
      summary: compactText(normalized, 160),
      content: normalized,
      applicabilityScope: "agent",
      confidenceScore: 0.7,
    };
  }

  if (/(?:remember|reference|dashboard|runbook|link)/iu.test(normalized)) {
    return {
      class: "project_context_note",
      title: "Project Context Note",
      summary: compactText(normalized, 160),
      content: normalized,
      applicabilityScope: "repository",
      confidenceScore: 0.64,
    };
  }

  return null;
}

function hasValidatedPositiveFeedbackSignal(text: string): boolean {
  return /(?:yes(?:,\s*)?(?:exactly|right)|perfect|keep doing|right call|good call|that was the right call|worked well|works well)/iu.test(
    text,
  );
}

function hasRelativeDateSignal(text: string): boolean {
  return /(?:\btoday\b|\btomorrow\b|\byesterday\b|\btonight\b|\bthis week\b|\bnext week\b|\bthis month\b|\bnext month\b|\bmonday\b|\btuesday\b|\bwednesday\b|\bthursday\b|\bfriday\b|\bsaturday\b|\bsunday\b)/iu.test(
    text,
  );
}

function shouldUseSemanticNarrativeExtraction(input: {
  text: string;
  candidateClass?:
    | "operator_preference"
    | "working_convention"
    | "project_context_note"
    | "external_reference_note";
}): boolean {
  return (
    hasValidatedPositiveFeedbackSignal(input.text) ||
    hasRelativeDateSignal(input.text) ||
    input.text.replace(/\s+/g, " ").trim().length >= 240 ||
    input.candidateClass === "project_context_note"
  );
}

export function createNarrativeMemoryLifecycle(
  runtime: BrewvaRuntime,
  semanticReranker?: BrewvaSemanticReranker,
): TurnLifecyclePort {
  const scratchBySession = new Map<string, NarrativeTurnScratch>();

  return {
    input(event, ctx) {
      const rawEvent = event as { text?: unknown };
      const sessionId = getSessionId(ctx);
      const text = readString(rawEvent.text);
      if (!sessionId || !text) {
        return undefined;
      }
      normalizeScratch(scratchBySession, sessionId).inputTexts.push(text);
      return undefined;
    },
    toolResult(event, ctx) {
      const rawEvent = event as {
        toolName?: unknown;
        input?: unknown;
        content?: unknown;
        isError?: unknown;
      };
      const sessionId = getSessionId(ctx);
      if (!sessionId) {
        return undefined;
      }
      const toolName = readString(rawEvent.toolName);
      const action = isRecord(rawEvent.input) ? readString(rawEvent.input.action) : undefined;
      const scratch = normalizeScratch(scratchBySession, sessionId);
      if (
        toolName === "narrative_memory" &&
        rawEvent.isError !== true &&
        ["remember", "review", "promote", "archive", "forget"].includes(action ?? "")
      ) {
        scratch.explicitMutationCommitted = true;
        return undefined;
      }
      if (!toolName) {
        return undefined;
      }
      const summary = compactText(extractTextContent(rawEvent.content), 220);
      if (!summary) {
        return undefined;
      }
      scratch.toolEvidence.push({
        toolName,
        summary,
        isError: rawEvent.isError === true,
      });
      return undefined;
    },
    async agentEnd(_event, ctx) {
      const sessionId = getSessionId(ctx);
      const scratch = sessionId ? scratchBySession.get(sessionId) : undefined;
      scratchBySession.delete(sessionId);
      if (
        !sessionId ||
        !scratch ||
        scratch.explicitMutationCommitted ||
        scratch.inputTexts.length === 0
      ) {
        return undefined;
      }

      const userText = scratch.inputTexts.join("\n").trim();
      if (!userText || !hasNarrativeSignal(userText)) {
        return undefined;
      }

      const targetRoots = runtime.inspect.task.getTargetDescriptor(sessionId).roots;
      const deterministicCandidate = inferDeterministicCandidate({ text: userText });
      let candidate = deterministicCandidate;
      let provenanceActor: "assistant" | "system" = "system";

      if (
        semanticReranker?.extractNarrativeMemoryCandidate &&
        shouldUseSemanticNarrativeExtraction({
          text: userText,
          candidateClass: deterministicCandidate?.class,
        })
      ) {
        const extracted = await semanticReranker.extractNarrativeMemoryCandidate({
          sessionId,
          agentId: runtime.agentId,
          targetRoots,
          userText,
          toolEvidence: scratch.toolEvidence,
        });
        if (extracted) {
          candidate = extracted;
          provenanceActor = "assistant";
        }
      }

      if (!candidate) {
        return undefined;
      }

      const plane = getOrCreateNarrativeMemoryPlane(runtime);
      const validation = validateNarrativeMemoryCandidate({
        workspaceRoot: runtime.workspaceRoot,
        agentId: runtime.agentId,
        plane,
        candidate: {
          class: candidate.class,
          title: candidate.title,
          content: candidate.content,
          applicabilityScope: candidate.applicabilityScope,
        },
      });
      if (!validation.ok) {
        return undefined;
      }

      const record = plane.addRecord({
        class: candidate.class,
        title: candidate.title,
        summary: candidate.summary,
        content: candidate.content,
        applicabilityScope: candidate.applicabilityScope,
        confidenceScore: candidate.confidenceScore,
        status: "proposed",
        retrievalCount: 0,
        provenance: {
          source: "passive_extraction",
          actor: provenanceActor,
          sessionId,
          agentId: runtime.agentId,
          targetRoots,
        },
        evidence: [
          {
            kind: "input_excerpt",
            summary: compactText(userText, 220),
            sessionId,
            timestamp: Date.now(),
          },
          ...scratch.toolEvidence.slice(0, 4).map((entry) => ({
            kind: "tool_result_excerpt" as const,
            summary: compactText(entry.summary, 220),
            sessionId,
            timestamp: Date.now(),
            toolName: entry.toolName,
          })),
        ],
      });
      recordRuntimeEvent(runtime, {
        sessionId,
        type: NARRATIVE_MEMORY_RECORDED_EVENT_TYPE,
        payload: {
          recordId: record.id,
          recordClass: record.class,
          status: record.status,
          provenanceSource: "passive_extraction",
          extractedBy: provenanceActor === "assistant" ? "semantic_oracle" : "deterministic_gate",
        },
      });
      return undefined;
    },
    sessionShutdown(_event, ctx) {
      scratchBySession.delete(getSessionId(ctx));
      return undefined;
    },
  };
}
