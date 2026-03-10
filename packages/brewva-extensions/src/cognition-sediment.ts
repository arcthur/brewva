import {
  DELIBERATION_ISSUERS,
  resolveCognitionArtifactsDir,
  selectCognitionArtifactsForPrompt,
  submitExistingCognitionArtifactContextPacket,
} from "@brewva/brewva-deliberation";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const COGNITION_REFERENCE_PACKET_TTL_MS = 6 * 60 * 60 * 1000;
const COGNITION_REFERENCE_REHYDRATED_EVENT_TYPE = "cognition_reference_rehydrated";
const COGNITION_REFERENCE_REHYDRATION_FAILED_EVENT_TYPE = "cognition_reference_rehydration_failed";

function buildPacketKey(fileName: string): string {
  return `reference:${fileName.replace(/\.(?:md|txt|json)$/u, "")}`;
}

function buildLabel(fileName: string): string {
  return `Reference:${fileName.replace(/\.(?:md|txt|json)$/u, "")}`;
}

export function registerCognitionSediment(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  const hydratedKeysBySession = new Map<string, Set<string>>();

  pi.on("before_agent_start", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const prompt = typeof (event as { prompt?: unknown }).prompt === "string" ? event.prompt : "";
    const selected = await selectCognitionArtifactsForPrompt({
      workspaceRoot: runtime.workspaceRoot,
      lane: "reference",
      prompt,
    });
    if (selected.length === 0) {
      return undefined;
    }

    const hydrated = hydratedKeysBySession.get(sessionId) ?? new Set<string>();
    hydratedKeysBySession.set(sessionId, hydrated);

    for (const match of selected) {
      const packetKey = buildPacketKey(match.artifact.fileName);
      if (hydrated.has(packetKey)) {
        continue;
      }

      try {
        const receipt = await submitExistingCognitionArtifactContextPacket({
          runtime,
          sessionId,
          issuer: DELIBERATION_ISSUERS.cognitionSediment,
          artifact: match.artifact,
          label: buildLabel(match.artifact.fileName),
          subject: `cognition_reference:${match.artifact.fileName}`,
          packetKey,
          expiresAt: Date.now() + COGNITION_REFERENCE_PACKET_TTL_MS,
          content: match.content,
        });
        if (receipt.receipt.decision === "accept") {
          hydrated.add(packetKey);
          runtime.events.record({
            sessionId,
            type: COGNITION_REFERENCE_REHYDRATED_EVENT_TYPE,
            payload: {
              artifactRef: match.artifact.artifactRef,
              packetKey,
              score: match.score,
              matchedTerms: match.matchedTerms,
            },
          });
          continue;
        }

        runtime.events.record({
          sessionId,
          type: COGNITION_REFERENCE_REHYDRATION_FAILED_EVENT_TYPE,
          payload: {
            artifactRef: match.artifact.artifactRef,
            packetKey,
            decision: receipt.receipt.decision,
            reasons: receipt.receipt.reasons,
          },
        });
      } catch (error) {
        runtime.events.record({
          sessionId,
          type: COGNITION_REFERENCE_REHYDRATION_FAILED_EVENT_TYPE,
          payload: {
            artifactRef: match.artifact.artifactRef,
            packetKey,
            reasons: [error instanceof Error ? error.message : String(error)],
            referenceDir: resolveCognitionArtifactsDir(runtime.workspaceRoot, "reference"),
          },
        });
      }
    }

    return undefined;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    hydratedKeysBySession.delete(ctx.sessionManager.getSessionId());
    return undefined;
  });
}
