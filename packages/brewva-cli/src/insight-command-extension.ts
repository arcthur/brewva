import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  buildInsightReport,
  clampText,
  formatInsightText,
  resolveInsightDirectory,
} from "./insight.js";

const DEFAULT_WIDGET_ID = "brewva-insight";
const DEFAULT_MAX_WIDGET_LINES = 28;
const DEFAULT_MAX_LINE_CHARS = 220;

function clearInsightWidget(ctx: ExtensionContext, widgetId: string): void {
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
  kept.push(`...[insight truncated: ${rawLines.length - kept.length} more lines]`);
  return kept;
}

function resolveVerdictNotifyLevel(
  verdict: ReturnType<typeof buildInsightReport>["verdict"],
): "info" | "warning" {
  if (verdict === "questionable" || verdict === "mixed") return "warning";
  return "info";
}

function normalizeCommandArgs(args: string): string | undefined {
  const trimmed = args.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function createInsightCommandExtension(
  runtime: BrewvaRuntime,
  options: {
    widgetId?: string;
    maxWidgetLines?: number;
    maxLineChars?: number;
  } = {},
): (pi: ExtensionAPI) => void {
  const widgetId = options.widgetId ?? DEFAULT_WIDGET_ID;
  const maxWidgetLines = Math.max(
    8,
    Math.trunc(options.maxWidgetLines ?? DEFAULT_MAX_WIDGET_LINES),
  );
  const maxLineChars = Math.max(40, Math.trunc(options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS));

  return (pi) => {
    pi.on("session_start", async (_event, ctx) => {
      clearInsightWidget(ctx, widgetId);
    });
    pi.on("session_switch", async (_event, ctx) => {
      clearInsightWidget(ctx, widgetId);
    });
    pi.on("session_shutdown", async (_event, ctx) => {
      clearInsightWidget(ctx, widgetId);
    });

    pi.registerCommand("insight", {
      description:
        "Review the current Brewva session for a directory without entering a model turn (usage: /insight [dir] | /insight clear)",
      handler: async (args, ctx) => {
        const normalizedArgs = normalizeCommandArgs(args);
        if (normalizedArgs === "clear") {
          clearInsightWidget(ctx, widgetId);
          if (ctx.hasUI) {
            ctx.ui.notify("Insight widget cleared.", "info");
          }
          return;
        }

        if (!ctx.hasUI) {
          return;
        }

        try {
          const directory = resolveInsightDirectory(runtime, normalizedArgs, undefined);
          const report = buildInsightReport({
            runtime,
            sessionId: ctx.sessionManager.getSessionId(),
            directory,
          });
          const text = formatInsightText(report);
          ctx.ui.setWidget(widgetId, toWidgetLines(text, maxWidgetLines, maxLineChars), {
            placement: "belowEditor",
          });
          ctx.ui.notify(
            `Insight updated for ${report.directory} (${report.verdict}). Use /insight clear to dismiss.`,
            resolveVerdictNotifyLevel(report.verdict),
          );
        } catch (error) {
          ctx.ui.notify(
            `Insight failed: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        }
      },
    });
  };
}
