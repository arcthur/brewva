import {
  inspectHostedDelegationCatalog,
  type AuthoredOverlaySummary,
  type HostedDelegationCatalogInspection,
} from "@brewva/brewva-gateway";
import type { RuntimePlugin, RuntimePluginApi } from "@brewva/brewva-gateway/runtime-plugins";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { BrewvaHostContext } from "@brewva/brewva-substrate";
import { clampText } from "./inspect-analysis.js";

const OVERLAY_WIDGET_ID = "brewva-agent-overlays";
const MAX_WIDGET_LINES = 28;
const MAX_LINE_CHARS = 220;

function clearOverlayWidget(ctx: BrewvaHostContext, widgetId: string): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(widgetId, undefined, {
    placement: "belowEditor",
  });
}

function toWidgetLines(text: string): string[] {
  const rawLines = text.split(/\r?\n/u).map((line) => clampText(line, MAX_LINE_CHARS));
  if (rawLines.length <= MAX_WIDGET_LINES) {
    return rawLines;
  }
  const kept = rawLines.slice(0, Math.max(1, MAX_WIDGET_LINES - 1));
  kept.push(`...[agent-overlays truncated: ${rawLines.length - kept.length} more lines]`);
  return kept;
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
    `Agent overlays — ${inspection.status}`,
    `Authored files: ${inspection.authoredFiles.length}`,
    `Workspace envelopes: ${inspection.workspaceEnvelopes.length}`,
    `Workspace agent specs: ${inspection.workspaceAgentSpecs.length}`,
  ];
  if (inspection.error) {
    lines.push(`Validation error: ${inspection.error}`);
  }
  if (inspection.authoredFiles.length === 0) {
    lines.push("No authored overlays found under .brewva/agents or .config/brewva/agents.");
    return lines.join("\n");
  }
  lines.push("Authored overlays:");
  for (const entry of inspection.authoredFiles) {
    const detail = [
      entry.kind,
      entry.extends ? `extends=${entry.extends}` : null,
      entry.envelope ? `envelope=${entry.envelope}` : null,
      entry.skillName ? `skill=${entry.skillName}` : null,
      entry.boundary ? `boundary=${entry.boundary}` : null,
      entry.model ? `model=${entry.model}` : null,
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
    return `No authored overlay named '${overlayName}' was found.`;
  }
  const envelope = inspection.workspaceEnvelopes.find((entry) => entry.name === overlayName);
  const agentSpec = inspection.workspaceAgentSpecs.find((entry) => entry.name === overlayName);
  const lines = [
    `Agent overlay ${overlayName} — ${inspection.status}`,
    `File: ${authored.filePath}`,
    `Kind: ${authored.kind}`,
    authored.extends ? `Extends: ${authored.extends}` : "Extends: none",
    authored.description ? `Description: ${authored.description}` : "Description: none",
  ];
  if (agentSpec) {
    lines.push(`Compiled envelope: ${agentSpec.envelope}`);
    lines.push(`Compiled skill: ${agentSpec.skillName ?? "none"}`);
    lines.push(`Compiled result mode: ${agentSpec.fallbackResultMode ?? "none"}`);
    lines.push(`Instructions markdown: ${agentSpec.instructionsMarkdown ? "present" : "absent"}`);
  }
  if (envelope) {
    lines.push(`Boundary: ${envelope.boundary ?? "safe"}`);
    lines.push(`Model: ${envelope.model ?? "none"}`);
    lines.push(`Builtin tools: ${(envelope.builtinToolNames ?? []).join(", ") || "none"}`);
    lines.push(`Managed tools: ${(envelope.managedToolNames ?? []).join(", ") || "none"}`);
  }
  if (inspection.error) {
    lines.push(`Validation error: ${inspection.error}`);
  }
  return lines.join("\n");
}

export function createAgentOverlaysCommandRuntimePlugin(runtime: BrewvaRuntime): RuntimePlugin {
  return (runtimePluginApi: RuntimePluginApi) => {
    runtimePluginApi.on("session_start", async (_event, ctx) => {
      clearOverlayWidget(ctx, OVERLAY_WIDGET_ID);
    });
    runtimePluginApi.on("session_switch", async (_event, ctx) => {
      clearOverlayWidget(ctx, OVERLAY_WIDGET_ID);
    });
    runtimePluginApi.on("session_shutdown", async (_event, ctx) => {
      clearOverlayWidget(ctx, OVERLAY_WIDGET_ID);
    });

    runtimePluginApi.registerCommand("agent-overlays", {
      description:
        "Inspect or validate authored delegated-worker overlays (usage: /agent-overlays | /agent-overlays validate | /agent-overlays <name> | /agent-overlays clear)",
      handler: async (args, ctx) => {
        const normalizedArgs = normalizeArgs(args);
        if (normalizedArgs === "clear") {
          clearOverlayWidget(ctx, OVERLAY_WIDGET_ID);
          if (ctx.hasUI) {
            ctx.ui.notify("Agent overlay widget cleared.", "info");
          }
          return;
        }
        const inspection = await inspectHostedDelegationCatalog(runtime.workspaceRoot);
        const text =
          normalizedArgs && normalizedArgs !== "validate"
            ? formatOverlayDetail(inspection, normalizedArgs)
            : formatOverlayList(inspection);
        if (ctx.hasUI) {
          ctx.ui.setWidget(OVERLAY_WIDGET_ID, toWidgetLines(text), {
            placement: "belowEditor",
          });
          ctx.ui.notify(
            inspection.status === "valid"
              ? normalizedArgs === "validate"
                ? "Agent overlay validation passed."
                : "Agent overlay inspection updated."
              : "Agent overlay inspection found validation errors.",
            inspection.status === "valid" ? "info" : "warning",
          );
        }
      },
    });
  };
}
