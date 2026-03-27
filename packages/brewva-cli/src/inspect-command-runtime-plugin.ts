import type { RuntimePlugin, RuntimePluginApi } from "@brewva/brewva-gateway/runtime-plugins";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { clampText, resolveInspectDirectory } from "./inspect-analysis.js";
import { buildSessionInspectReport, formatInspectText } from "./inspect.js";

const DEFAULT_WIDGET_ID = "brewva-inspect";
const DEFAULT_MAX_WIDGET_LINES = 28;
const DEFAULT_MAX_LINE_CHARS = 220;

function clearInspectWidget(ctx: ExtensionContext, widgetId: string): void {
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
  kept.push(`...[inspect truncated: ${rawLines.length - kept.length} more lines]`);
  return kept;
}

function resolveVerdictNotifyLevel(
  verdict: ReturnType<typeof buildSessionInspectReport>["verdict"],
): "info" | "warning" {
  if (verdict === "questionable" || verdict === "mixed") return "warning";
  return "info";
}

function normalizeCommandArgs(args: string): string | undefined {
  const trimmed = args.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function createInspectCommandRuntimePlugin(
  runtime: BrewvaRuntime,
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
      clearInspectWidget(ctx, widgetId);
    });
    runtimePluginApi.on("session_switch", async (_event, ctx) => {
      clearInspectWidget(ctx, widgetId);
    });
    runtimePluginApi.on("session_shutdown", async (_event, ctx) => {
      clearInspectWidget(ctx, widgetId);
    });

    const handler = async (args: string, ctx: ExtensionContext) => {
      const normalizedArgs = normalizeCommandArgs(args);
      if (normalizedArgs === "clear") {
        clearInspectWidget(ctx, widgetId);
        if (ctx.hasUI) {
          ctx.ui.notify("Inspect widget cleared.", "info");
        }
        return;
      }

      if (!ctx.hasUI) {
        return;
      }

      try {
        const directory = resolveInspectDirectory(runtime, normalizedArgs, undefined);
        const report = buildSessionInspectReport({
          runtime,
          sessionId: ctx.sessionManager.getSessionId(),
          directory,
        });
        const text = formatInspectText(report.base);
        ctx.ui.setWidget(widgetId, toWidgetLines(text, maxWidgetLines, maxLineChars), {
          placement: "belowEditor",
        });
        ctx.ui.notify(
          `Inspect updated for ${report.directory} (${report.verdict}). Use /inspect clear to dismiss.`,
          resolveVerdictNotifyLevel(report.verdict),
        );
      } catch (error) {
        ctx.ui.notify(
          `Inspect failed: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    };

    runtimePluginApi.registerCommand("inspect", {
      description:
        "Review the current Brewva session for a directory without entering a model turn (usage: /inspect [dir] | /inspect clear)",
      handler,
    });
  };
}
