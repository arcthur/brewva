import {
  DELIBERATION_MEMORY_ARTIFACT_KINDS,
  DELIBERATION_MEMORY_RETENTION_BANDS,
  DELIBERATION_MEMORY_SCOPE_VALUES,
  getOrCreateDeliberationMemoryPlane,
  resolveDeliberationMemoryRetentionSnapshot,
  type DeliberationMemoryArtifact,
  type DeliberationMemoryState,
} from "@brewva/brewva-deliberation";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { shouldInvokeSemanticRerank } from "./semantic-oracle.js";
import type { BrewvaToolOptions } from "./types.js";
import { buildStringEnumSchema } from "./utils/input-alias.js";
import { failTextResult, inconclusiveTextResult, textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineBrewvaTool } from "./utils/tool.js";

const ACTION_VALUES = ["list", "show", "retrieve", "stats"] as const;

const ActionSchema = buildStringEnumSchema(ACTION_VALUES, {});
const KindSchema = buildStringEnumSchema(DELIBERATION_MEMORY_ARTIFACT_KINDS, {});
const ScopeSchema = buildStringEnumSchema(DELIBERATION_MEMORY_SCOPE_VALUES, {});

function readKind(value: unknown): (typeof DELIBERATION_MEMORY_ARTIFACT_KINDS)[number] | undefined {
  return typeof value === "string" &&
    DELIBERATION_MEMORY_ARTIFACT_KINDS.includes(
      value as (typeof DELIBERATION_MEMORY_ARTIFACT_KINDS)[number],
    )
    ? (value as (typeof DELIBERATION_MEMORY_ARTIFACT_KINDS)[number])
    : undefined;
}

function readScope(value: unknown): (typeof DELIBERATION_MEMORY_SCOPE_VALUES)[number] | undefined {
  return typeof value === "string" &&
    DELIBERATION_MEMORY_SCOPE_VALUES.includes(
      value as (typeof DELIBERATION_MEMORY_SCOPE_VALUES)[number],
    )
    ? (value as (typeof DELIBERATION_MEMORY_SCOPE_VALUES)[number])
    : undefined;
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function formatArtifactSummary(artifact: DeliberationMemoryArtifact): string {
  const retention =
    artifact.metadata?.retention ??
    resolveDeliberationMemoryRetentionSnapshot({
      artifact,
    });
  return [
    `- ${artifact.id}`,
    `  kind=${artifact.kind}`,
    `  scope=${artifact.applicabilityScope}`,
    `  retention=${retention.band}:${retention.retentionScore.toFixed(2)}`,
    `  confidence=${artifact.confidenceScore.toFixed(2)}`,
    `  last_validated_at=${new Date(artifact.lastValidatedAt).toISOString()}`,
    `  summary=${artifact.summary}`,
  ].join("\n");
}

function formatArtifactDetail(artifact: DeliberationMemoryArtifact): string {
  const retention =
    artifact.metadata?.retention ??
    resolveDeliberationMemoryRetentionSnapshot({
      artifact,
    });
  const lines = [
    "# Deliberation Memory",
    `id: ${artifact.id}`,
    `kind: ${artifact.kind}`,
    `scope: ${artifact.applicabilityScope}`,
    `title: ${artifact.title}`,
    `confidence_score: ${artifact.confidenceScore.toFixed(2)}`,
    `retention_band: ${retention.band}`,
    `retention_score: ${retention.retentionScore.toFixed(2)}`,
    `retrieval_bias: ${retention.retrievalBias.toFixed(2)}`,
    `decay_factor: ${retention.decayFactor.toFixed(2)}`,
    `age_days: ${retention.ageDays.toFixed(1)}`,
    `evidence_count: ${retention.evidenceCount}`,
    `session_span: ${retention.sessionSpan}`,
    `first_captured_at: ${new Date(artifact.firstCapturedAt).toISOString()}`,
    `last_validated_at: ${new Date(artifact.lastValidatedAt).toISOString()}`,
    "",
    "## Summary",
    artifact.summary,
    "",
    "## Content",
    artifact.content,
    "",
    "## Tags",
    artifact.tags.length > 0 ? artifact.tags.join(", ") : "none",
    "",
    "## Sessions",
    artifact.sessionIds.length > 0 ? artifact.sessionIds.join(", ") : "none",
  ];

  if (artifact.evidence.length > 0) {
    lines.push("", "## Evidence");
    for (const evidence of artifact.evidence.slice(0, 10)) {
      lines.push(
        `- session=${evidence.sessionId} event=${evidence.eventId} type=${evidence.eventType} at=${new Date(evidence.timestamp).toISOString()}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function formatStats(state: DeliberationMemoryState): string {
  const kindCounts = new Map<string, number>();
  const scopeCounts = new Map<string, number>();
  const bandCounts = new Map<string, number>();

  for (const artifact of state.artifacts) {
    const retention =
      artifact.metadata?.retention ??
      resolveDeliberationMemoryRetentionSnapshot({
        artifact,
        now: state.updatedAt,
      });
    kindCounts.set(artifact.kind, (kindCounts.get(artifact.kind) ?? 0) + 1);
    scopeCounts.set(
      artifact.applicabilityScope,
      (scopeCounts.get(artifact.applicabilityScope) ?? 0) + 1,
    );
    bandCounts.set(retention.band, (bandCounts.get(retention.band) ?? 0) + 1);
  }

  const renderMap = (values: Map<string, number>, orderedKeys?: readonly string[]) =>
    (orderedKeys ?? [...values.keys()].toSorted())
      .map((key) => `${key}=${values.get(key) ?? 0}`)
      .join(", ") || "none";

  return [
    "# Deliberation Memory Stats",
    `updated_at: ${new Date(state.updatedAt).toISOString()}`,
    `artifacts: ${state.artifacts.length}`,
    `sessions: ${state.sessionDigests.length}`,
    `kinds: ${renderMap(kindCounts, DELIBERATION_MEMORY_ARTIFACT_KINDS)}`,
    `scopes: ${renderMap(scopeCounts, DELIBERATION_MEMORY_SCOPE_VALUES)}`,
    `retention_bands: ${renderMap(bandCounts, DELIBERATION_MEMORY_RETENTION_BANDS)}`,
  ].join("\n");
}

export function createDeliberationMemoryTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "deliberation_memory",
    label: "Deliberation Memory",
    description:
      "Inspect evidence-backed deliberation memory artifacts, retrieval ranking, and retention state without widening runtime authority.",
    promptSnippet:
      "Use this to inspect repository, user, agent, or loop memory artifacts explicitly instead of assuming hidden long-term memory.",
    promptGuidelines: [
      "Use stats or list before show when you do not yet know which artifact or scope is most relevant.",
      "Retrieve is query-scored inspection only. It does not create new memory or mutate kernel truth.",
    ],
    parameters: Type.Object({
      action: ActionSchema,
      artifact_id: Type.Optional(Type.String({ minLength: 1 })),
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
      kind: Type.Optional(KindSchema),
      scope: Type.Optional(ScopeSchema),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const plane = getOrCreateDeliberationMemoryPlane(options.runtime);
      const kind = readKind(params.kind);
      const scope = readScope(params.scope);
      const artifactId = readTrimmedString(params.artifact_id);
      const query = readTrimmedString(params.query);
      const limit = Math.max(1, Math.min(20, params.limit ?? 10));
      const sessionId = getSessionId(ctx);
      const targetRoots = options.runtime.task.getTargetDescriptor(sessionId).roots;

      if (params.action === "stats") {
        const state = plane.getState();
        return textResult(formatStats(state), {
          ok: true,
          artifactCount: state.artifacts.length,
          sessionCount: state.sessionDigests.length,
        });
      }

      if (params.action === "list") {
        const artifacts = plane.list({
          kind,
          applicabilityScope: scope,
          limit,
        });
        if (artifacts.length === 0) {
          return inconclusiveTextResult(
            "No deliberation memory artifacts match the current filter.",
            {
              ok: false,
              kind: kind ?? null,
              scope: scope ?? null,
              artifacts: [],
            },
          );
        }
        return textResult(
          [
            "# Deliberation Memory Artifacts",
            `count: ${artifacts.length}`,
            ...artifacts.map(formatArtifactSummary),
          ].join("\n"),
          {
            ok: true,
            kind: kind ?? null,
            scope: scope ?? null,
            artifacts,
          },
        );
      }

      if (params.action === "retrieve") {
        if (!query) {
          return failTextResult("retrieve requires query.", {
            ok: false,
            error: "missing_query",
          });
        }
        let retrievals = plane
          .retrieve(query, Math.max(limit * 3, limit), targetRoots)
          .filter((entry) => !kind || entry.artifact.kind === kind)
          .filter((entry) => !scope || entry.artifact.applicabilityScope === scope);
        const oracle = options.runtime.semanticOracle;
        if (
          retrievals.length >= 3 &&
          oracle?.rerankDeliberationMemory &&
          shouldInvokeSemanticRerank(retrievals.map((entry) => entry.score))
        ) {
          const reranked = await oracle.rerankDeliberationMemory({
            sessionId,
            surface: "deliberation_memory",
            query,
            targetRoots,
            stateRevision: String(plane.getState().updatedAt),
            artifacts: retrievals.map((entry) => entry.artifact),
            candidates: retrievals.map((entry) => ({
              id: entry.artifact.id,
              title: entry.artifact.title,
              summary: entry.artifact.summary,
              content: entry.artifact.content,
              kind: entry.artifact.kind,
              scope: entry.artifact.applicabilityScope,
            })),
          });
          if (reranked) {
            const byId = new Map(retrievals.map((entry) => [entry.artifact.id, entry] as const));
            retrievals = reranked.orderedIds
              .map((id) => byId.get(id))
              .filter((entry): entry is (typeof retrievals)[number] => Boolean(entry));
          }
        }
        retrievals = retrievals.slice(0, limit);
        if (retrievals.length === 0) {
          return inconclusiveTextResult(
            "No deliberation memory artifacts matched the retrieval query.",
            {
              ok: false,
              query,
              kind: kind ?? null,
              scope: scope ?? null,
              retrievals: [],
            },
          );
        }
        return textResult(
          [
            "# Deliberation Memory Retrieval",
            `count: ${retrievals.length}`,
            ...retrievals.map(
              (entry) =>
                `${formatArtifactSummary(entry.artifact)}\n  retrieval_score=${entry.score.toFixed(2)}`,
            ),
          ].join("\n"),
          {
            ok: true,
            query,
            kind: kind ?? null,
            scope: scope ?? null,
            retrievals,
          },
        );
      }

      if (!artifactId) {
        return failTextResult("show requires artifact_id.", {
          ok: false,
          error: "missing_artifact_id",
        });
      }

      const artifact = plane.getArtifact(artifactId);
      if (!artifact) {
        return failTextResult(`Deliberation memory artifact not found: ${artifactId}`, {
          ok: false,
          error: "artifact_not_found",
          artifactId,
        });
      }

      return textResult(formatArtifactDetail(artifact), {
        ok: true,
        artifact,
      });
    },
  });
}
