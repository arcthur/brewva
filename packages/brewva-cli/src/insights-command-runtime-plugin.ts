import {
  defineInternalRuntimePlugin,
  type InternalRuntimePlugin,
  type InternalRuntimePluginApi,
} from "@brewva/brewva-gateway/runtime-plugins";
import type { BrewvaOperatorRuntimePort } from "@brewva/brewva-runtime";
import { clampText, resolveInspectDirectory } from "./inspect-analysis.js";

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

export function createInsightsCommandRuntimePlugin(
  runtime: BrewvaOperatorRuntimePort,
  options: {
    maxNotificationLines?: number;
    maxLineChars?: number;
  } = {},
): InternalRuntimePlugin {
  const maxNotificationLines = Math.max(
    8,
    Math.trunc(options.maxNotificationLines ?? DEFAULT_MAX_NOTIFICATION_LINES),
  );
  const maxLineChars = Math.max(40, Math.trunc(options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS));

  return defineInternalRuntimePlugin({
    name: "cli.insights_command",
    capabilities: ["tool_registration.write"],
    register(runtimePluginApi: InternalRuntimePluginApi) {
      runtimePluginApi.registerCommand("insights", {
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
              await import("./insights.js");
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
