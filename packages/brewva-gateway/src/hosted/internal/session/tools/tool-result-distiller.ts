import { isRecord } from "@brewva/brewva-std/unknown";
import type { InternalHostPluginApi } from "@brewva/brewva-substrate/host-api";
import type { HostedRuntimeAdapterPort } from "../runtime-ports.js";
import { distillToolOutput } from "./tool-output-distiller.js";

function extractTextOnlyContent(content: unknown): string | undefined {
  if (!Array.isArray(content) || content.length === 0) {
    return "";
  }

  const lines: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      return undefined;
    }
    const part = item as { type?: unknown; text?: unknown };
    if (part.type !== "text" || typeof part.text !== "string") {
      return undefined;
    }
    lines.push(part.text);
  }
  return lines.join("\n");
}

function extractArtifactRef(details: Record<string, unknown> | undefined): string | null {
  const direct = details?.artifactRef;
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }
  const outputArtifact = details?.outputArtifact;
  if (isRecord(outputArtifact)) {
    const artifactRef = (outputArtifact as { artifactRef?: unknown }).artifactRef;
    if (typeof artifactRef === "string" && artifactRef.trim().length > 0) {
      return artifactRef.trim();
    }
  }
  return null;
}

export function registerToolResultDistiller(
  extensionApi: InternalHostPluginApi,
  _runtime: HostedRuntimeAdapterPort,
): void {
  extensionApi.on("tool_result", (event) => {
    const outputText = extractTextOnlyContent(event.content);
    if (outputText === undefined) {
      return undefined;
    }

    const details =
      event.details && typeof event.details === "object" && !Array.isArray(event.details)
        ? (event.details as Record<string, unknown>)
        : undefined;
    const distillation = distillToolOutput({
      toolName: event.toolName,
      isError: event.isError,
      verdict: event.isError ? "fail" : undefined,
      outputText,
    });
    if (!distillation.distillationApplied || !distillation.summaryText.trim()) {
      return undefined;
    }

    return {
      content: [{ type: "text" as const, text: distillation.summaryText.trim() }],
      details: {
        ...details,
        outputDistillation: {
          strategy: distillation.strategy,
          rawChars: distillation.rawChars,
          rawBytes: distillation.rawBytes,
          rawTokens: distillation.rawTokens,
          summaryChars: distillation.summaryChars,
          summaryBytes: distillation.summaryBytes,
          summaryTokens: distillation.summaryTokens,
          compressionRatio: distillation.compressionRatio,
          truncated: distillation.truncated,
          artifactRef: extractArtifactRef(details),
        },
      },
    };
  });
}
