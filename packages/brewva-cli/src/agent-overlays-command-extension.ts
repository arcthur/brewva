import {
  inspectHostedDelegationCatalog,
  type AuthoredOverlaySummary,
  type HostedDelegationCatalogInspection,
} from "@brewva/brewva-gateway";
import {
  defineHostedExtensionPlugin,
  type HostedExtensionPlugin,
  type HostedExtensionApi,
} from "@brewva/brewva-gateway/extensions";
import type { BrewvaRuntimeRoot } from "@brewva/brewva-runtime";
import { clampText } from "./inspect-analysis.js";

const MAX_NOTIFICATION_LINES = 28;
const MAX_LINE_CHARS = 220;

function toNotificationMessage(summary: string, text: string): string {
  const rawLines = text.split(/\r?\n/u).map((line) => clampText(line, MAX_LINE_CHARS));
  if (rawLines.length > MAX_NOTIFICATION_LINES) {
    const kept = rawLines.slice(0, Math.max(1, MAX_NOTIFICATION_LINES - 1));
    kept.push(`...[agent-overlays truncated: ${rawLines.length - kept.length} more lines]`);
    return [summary, "", ...kept].join("\n");
  }
  return [summary, "", ...rawLines].join("\n");
}

function normalizeArgs(args: string): string | undefined {
  const trimmed = args.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function findAuthoredOverlay(
  inspection: HostedDelegationCatalogInspection,
  name: string,
): AuthoredOverlaySummary | undefined {
  return inspection.authoredFiles.find((entry) => entry.name === name);
}

function formatOverlayList(inspection: HostedDelegationCatalogInspection): string {
  const lines = [
    `Custom subagents — ${inspection.status}`,
    `Authored files: ${inspection.authoredFiles.length}`,
    `Custom specialists: ${inspection.customSpecialists.length}`,
  ];
  if (inspection.error) {
    lines.push(`Validation error: ${inspection.error}`);
  }
  if (inspection.authoredFiles.length === 0) {
    lines.push(
      "No authored custom subagents found under .brewva/subagents or ~/.brewva/subagents.",
    );
    return lines.join("\n");
  }
  lines.push("Authored custom subagents:");
  for (const entry of inspection.authoredFiles) {
    const detail = [
      entry.extends ? `extends=${entry.extends}` : null,
      entry.modelPreset ? `modelPreset=${entry.modelPreset}` : null,
      entry.reasoningEffort ? `reasoningEffort=${entry.reasoningEffort}` : null,
      entry.tools?.length ? `tools=${entry.tools.join(",")}` : null,
    ].filter(Boolean);
    lines.push(`- ${entry.name ?? entry.fileName} (${detail.join(" ") || entry.source})`);
    lines.push(`  ${entry.filePath}`);
  }
  return lines.join("\n");
}

function formatOverlayDetail(
  inspection: HostedDelegationCatalogInspection,
  overlayName: string,
): string {
  const authored = findAuthoredOverlay(inspection, overlayName);
  if (!authored) {
    return `No authored custom subagent named '${overlayName}' was found.`;
  }
  const agentSpec = inspection.customSpecialists.find((entry) => entry.name === overlayName);
  const lines = [
    `Custom subagent ${overlayName} — ${inspection.status}`,
    `File: ${authored.filePath}`,
    authored.extends ? `Extends: ${authored.extends}` : "Extends: none",
    authored.description ? `Description: ${authored.description}` : "Description: none",
    authored.modelPreset ? `Model preset: ${authored.modelPreset}` : "Model preset: inherited",
    authored.reasoningEffort
      ? `Reasoning effort: ${authored.reasoningEffort}`
      : "Reasoning effort: inherited",
    `Tools: ${(authored.tools ?? []).join(", ") || "inherited"}`,
  ];
  if (agentSpec) {
    lines.push(`Compiled envelope: ${agentSpec.envelope}`);
    lines.push(`Instructions markdown: ${agentSpec.instructionsMarkdown ? "present" : "absent"}`);
  }
  if (inspection.error) {
    lines.push(`Validation error: ${inspection.error}`);
  }
  return lines.join("\n");
}

export function createAgentOverlaysCommandExtension(
  runtime: BrewvaRuntimeRoot,
): HostedExtensionPlugin {
  return defineHostedExtensionPlugin({
    name: "cli.agent_overlays_command",
    capabilities: ["tool_registration.write"],
    register(extensionApi: HostedExtensionApi) {
      extensionApi.registerCommand("agent-overlays", {
        description:
          "Inspect or validate authored custom subagents (usage: /agent-overlays | /agent-overlays validate | /agent-overlays <name>)",
        handler: async (args, ctx) => {
          const normalizedArgs = normalizeArgs(args);
          const inspection = await inspectHostedDelegationCatalog(runtime.identity.workspaceRoot);
          const text =
            normalizedArgs && normalizedArgs !== "validate"
              ? formatOverlayDetail(inspection, normalizedArgs)
              : formatOverlayList(inspection);
          if (ctx.hasUI) {
            const summary =
              inspection.status === "valid"
                ? normalizedArgs === "validate"
                  ? "Custom subagent validation passed."
                  : "Custom subagent inspection report."
                : "Custom subagent inspection found validation errors.";
            ctx.ui.notify(
              toNotificationMessage(summary, text),
              inspection.status === "valid" ? "info" : "warning",
            );
          }
        },
      });
    },
  });
}
