import {
  MEMORY_REFERENCE_REHYDRATED_EVENT_TYPE,
  MEMORY_REFERENCE_REHYDRATION_FAILED_EVENT_TYPE,
  MEMORY_SUMMARY_REHYDRATED_EVENT_TYPE,
  MEMORY_SUMMARY_REHYDRATION_FAILED_EVENT_TYPE,
  type BrewvaRuntime,
} from "@brewva/brewva-runtime";
import {
  extractStatusSummarySessionScope,
  listCognitionArtifacts,
  parseStatusSummaryPacketContent,
  readCognitionArtifact,
  selectCognitionArtifactsForPrompt,
  stripArtifactExtension,
  submitExistingCognitionArtifactContextPacket,
} from "./cognition.js";
import { DELIBERATION_ISSUERS } from "./proposals.js";

const ISSUER = DELIBERATION_ISSUERS.memoryCurator;

function getOrCreateHydratedPackets(
  stateBySession: Map<string, Set<string>>,
  sessionId: string,
): Set<string> {
  const existing = stateBySession.get(sessionId);
  if (existing) {
    return existing;
  }
  const created = new Set<string>();
  stateBySession.set(sessionId, created);
  return created;
}

function buildPacketKey(lane: "reference" | "summary", fileName: string): string {
  return `${lane}:${stripArtifactExtension(fileName)}`;
}

async function submitPacket(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  packetKey: string;
  successEventType: string;
  failureEventType: string;
  artifact: Awaited<ReturnType<typeof listCognitionArtifacts>>[number];
  content?: string;
  profile?: "status_summary";
}): Promise<void> {
  try {
    await submitExistingCognitionArtifactContextPacket({
      runtime: input.runtime,
      sessionId: input.sessionId,
      issuer: ISSUER,
      artifact: input.artifact,
      packetKey: input.packetKey,
      content: input.content,
      profile: input.profile,
    });
    input.runtime.events.record({
      sessionId: input.sessionId,
      type: input.successEventType,
      payload: {
        packetKey: input.packetKey,
        artifactRef: input.artifact.artifactRef,
      },
    });
  } catch (error) {
    input.runtime.events.record({
      sessionId: input.sessionId,
      type: input.failureEventType,
      payload: {
        packetKey: input.packetKey,
        artifactRef: input.artifact.artifactRef,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

async function findLatestSessionSummary(
  runtime: BrewvaRuntime,
  sessionId: string,
): Promise<{
  artifact: Awaited<ReturnType<typeof listCognitionArtifacts>>[number];
  content: string;
} | null> {
  const artifacts = await listCognitionArtifacts(runtime.workspaceRoot, "summaries");
  for (const artifact of artifacts.toReversed()) {
    const content = await readCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "summaries",
      fileName: artifact.fileName,
    });
    if (!parseStatusSummaryPacketContent(content)) {
      continue;
    }
    if (extractStatusSummarySessionScope(content) !== sessionId) {
      continue;
    }
    return { artifact, content };
  }
  return null;
}

export interface MemoryCuratorLifecycle {
  beforeAgentStart: (event: unknown, ctx: unknown) => Promise<undefined>;
  sessionShutdown: (event: unknown, ctx: unknown) => undefined;
}

export function createMemoryCuratorLifecycle(runtime: BrewvaRuntime): MemoryCuratorLifecycle {
  const hydratedPacketsBySession = new Map<string, Set<string>>();

  return {
    async beforeAgentStart(event, ctx) {
      const rawEvent = event as { prompt?: unknown };
      const sessionId = (
        ctx as { sessionManager: { getSessionId: () => string } }
      ).sessionManager.getSessionId();
      const hydratedPackets = getOrCreateHydratedPackets(hydratedPacketsBySession, sessionId);
      const prompt = typeof rawEvent.prompt === "string" ? rawEvent.prompt : "";

      const referenceMatches = await selectCognitionArtifactsForPrompt({
        workspaceRoot: runtime.workspaceRoot,
        lane: "reference",
        prompt,
        maxArtifacts: 2,
        scanLimit: 16,
      });
      for (const match of referenceMatches) {
        const packetKey = buildPacketKey("reference", match.artifact.fileName);
        if (hydratedPackets.has(packetKey)) {
          continue;
        }
        await submitPacket({
          runtime,
          sessionId,
          packetKey,
          successEventType: MEMORY_REFERENCE_REHYDRATED_EVENT_TYPE,
          failureEventType: MEMORY_REFERENCE_REHYDRATION_FAILED_EVENT_TYPE,
          artifact: match.artifact,
          content: match.content,
        });
        hydratedPackets.add(packetKey);
      }

      const summary = await findLatestSessionSummary(runtime, sessionId);
      if (summary) {
        const packetKey = buildPacketKey("summary", summary.artifact.fileName);
        if (!hydratedPackets.has(packetKey)) {
          await submitPacket({
            runtime,
            sessionId,
            packetKey,
            successEventType: MEMORY_SUMMARY_REHYDRATED_EVENT_TYPE,
            failureEventType: MEMORY_SUMMARY_REHYDRATION_FAILED_EVENT_TYPE,
            artifact: summary.artifact,
            content: summary.content,
            profile: "status_summary",
          });
          hydratedPackets.add(packetKey);
        }
      }

      return undefined;
    },
    sessionShutdown(_event, ctx) {
      hydratedPacketsBySession.delete(
        (ctx as { sessionManager: { getSessionId: () => string } }).sessionManager.getSessionId(),
      );
      return undefined;
    },
  };
}
