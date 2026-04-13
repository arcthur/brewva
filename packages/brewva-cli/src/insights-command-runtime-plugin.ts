import type { RuntimePlugin, RuntimePluginApi } from "@brewva/brewva-gateway/runtime-plugins";
import type { BrewvaOperatorRuntimePort } from "@brewva/brewva-runtime";
import type { BrewvaHostContext } from "@brewva/brewva-substrate";
import { buildProjectInsightsReport, formatProjectInsightsText } from "./insights.js";
import { clampText, resolveInspectDirectory } from "./inspect-analysis.js";

const DEFAULT_WIDGET_ID = "brewva-insights";
const DEFAULT_MAX_WIDGET_LINES = 28;
const DEFAULT_MAX_LINE_CHARS = 220;

function clearInsightsWidget(ctx: BrewvaHostContext, widgetId: string): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(widgetId, undefined, {
    placement: "belowEditor",
  });
}

function toWidgetLines(text: string, maxLines: number, maxLineChars: number): string[] {
  const rawLines = text.split(/\r?\n/u).map((line) => clampText(line, maxLineChars));
  if (rawLines.length <= maxLines) {
    return rawLines;
  }
  const kept = rawLines.slice(0, Math.max(1, maxLines - 1));
  kept.push(`...[insights truncated: ${rawLines.length - kept.length} more lines]`);
  return kept;
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
    widgetId?: string;
    maxWidgetLines?: number;
    maxLineChars?: number;
  } = {},
): RuntimePlugin {
  const widgetId = options.widgetId ?? DEFAULT_WIDGET_ID;
  const maxWidgetLines = Math.max(
    8,
    Math.trunc(options.maxWidgetLines ?? DEFAULT_MAX_WIDGET_LINES),
  );
  const maxLineChars = Math.max(40, Math.trunc(options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS));

  return (runtimePluginApi: RuntimePluginApi) => {
    runtimePluginApi.on("session_start", async (_event, ctx) => {
      clearInsightsWidget(ctx, widgetId);
    });
    runtimePluginApi.on("session_switch", async (_event, ctx) => {
      clearInsightsWidget(ctx, widgetId);
    });
    runtimePluginApi.on("session_shutdown", async (_event, ctx) => {
      clearInsightsWidget(ctx, widgetId);
    });

    runtimePluginApi.registerCommand("insights", {
      description:
        "Multi-session aggregated insights for a directory (usage: /insights [dir] | /insights clear)",
      handler: async (args, ctx) => {
        const normalizedArgs = args.trim();
        if (normalizedArgs === "clear") {
          clearInsightsWidget(ctx, widgetId);
          if (ctx.hasUI) {
            ctx.ui.notify("Insights widget cleared.", "info");
          }
          return;
        }

        if (!ctx.hasUI) {
          return;
        }

        try {
          const directory = resolveInspectDirectory(
            runtime,
            normalizedArgs.length > 0 ? normalizedArgs : undefined,
            undefined,
          );
          const report = buildProjectInsightsReport({
            runtime,
            directory,
          });
          const text = formatProjectInsightsText(report);
          ctx.ui.setWidget(widgetId, toWidgetLines(text, maxWidgetLines, maxLineChars), {
            placement: "belowEditor",
          });
          ctx.ui.notify(
            `Insights updated for ${report.directory || "."} (${report.window.analyzedSessions} analyzed, ${report.window.failedSessions} failed). Use /insights clear to dismiss.`,
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
  };
}
