import {
  defineHostedExtensionPlugin,
  type HostedExtensionPlugin,
  type HostedExtensionApi,
} from "@brewva/brewva-gateway/extensions";
import type { HostedRuntimeAdapterPort } from "@brewva/brewva-gateway/hosted";
import { clampText, resolveInspectDirectory } from "../../operator/inspect-analysis.js";

const DEFAULT_MAX_NOTIFICATION_LINES = 28;
const DEFAULT_MAX_LINE_CHARS = 220;

function toNotificationMessage(
  summary: string,
  text: string,
  maxLines: number,
  maxLineChars: number,
): string {
  const rawLines = text.split(/\r?\n/u).map((line) => clampText(line, maxLineChars));
  if (rawLines.length > maxLines) {
    const kept = rawLines.slice(0, Math.max(1, maxLines - 1));
    kept.push(`...[insights truncated: ${rawLines.length - kept.length} more lines]`);
    return [summary, "", ...kept].join("\n");
  }
  return [summary, "", ...rawLines].join("\n");
}

function resolveInsightsNotifyLevel(input: {
  analyzedSessions: number;
  failedSessions: number;
}): "info" | "warning" {
  if (input.failedSessions > 0 || input.analyzedSessions === 0) {
    return "warning";
  }
  return "info";
}

export function createInsightsCommandExtension(
  runtime: HostedRuntimeAdapterPort,
  options: {
    maxNotificationLines?: number;
    maxLineChars?: number;
  } = {},
): HostedExtensionPlugin {
  const maxNotificationLines = Math.max(
    8,
    Math.trunc(options.maxNotificationLines ?? DEFAULT_MAX_NOTIFICATION_LINES),
  );
  const maxLineChars = Math.max(40, Math.trunc(options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS));

  return defineHostedExtensionPlugin({
    name: "cli.insights_command",
    capabilities: ["tool_registration.write"],
    register(extensionApi: HostedExtensionApi) {
      extensionApi.registerCommand("insights", {
        description: "Multi-session aggregated insights for a directory (usage: /insights [dir])",
        handler: async (args, ctx) => {
          const normalizedArgs = args.trim();
          if (!ctx.hasUI) {
            return;
          }

          try {
            const directory = resolveInspectDirectory(
              runtime,
              normalizedArgs.length > 0 ? normalizedArgs : undefined,
              undefined,
            );
            const { buildProjectInsightsReport, formatProjectInsightsText } =
              await import("../../operator/insights.js");
            const report = await buildProjectInsightsReport({
              runtime,
              directory,
            });
            const text = formatProjectInsightsText(report);
            const summary = `Insights report for ${report.directory || "."} (${report.window.analyzedSessions} analyzed, ${report.window.failedSessions} failed).`;
            ctx.ui.notify(
              toNotificationMessage(summary, text, maxNotificationLines, maxLineChars),
              resolveInsightsNotifyLevel({
                analyzedSessions: report.window.analyzedSessions,
                failedSessions: report.window.failedSessions,
              }),
            );
          } catch (error) {
            ctx.ui.notify(
              `Insights failed: ${error instanceof Error ? error.message : String(error)}`,
              "warning",
            );
          }
        },
      });
    },
  });
}
