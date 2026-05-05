import {
  defineInternalRuntimePlugin,
  type InternalRuntimePlugin,
  type InternalRuntimePluginApi,
} from "@brewva/brewva-gateway/runtime-plugins";
import type { BrewvaOperatorRuntimePort } from "@brewva/brewva-runtime";
import type { BrewvaHostContext } from "@brewva/brewva-substrate/host-api";
import { clampText, resolveInspectDirectory } from "./inspect-analysis.js";
import { buildSessionInspectReport, formatInspectText } from "./inspect.js";

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
    kept.push(`...[inspect truncated: ${rawLines.length - kept.length} more lines]`);
    return [summary, "", ...kept].join("\n");
  }
  return [summary, "", ...rawLines].join("\n");
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
    name: "cli.inspect_command",
    capabilities: ["tool_registration.write"],
    register(runtimePluginApi: InternalRuntimePluginApi) {
      const handler = async (args: string, ctx: BrewvaHostContext) => {
        const normalizedArgs = normalizeCommandArgs(args);
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
          const summary = `Inspect report for ${report.directory} (${report.verdict}).`;
          ctx.ui.notify(
            toNotificationMessage(summary, text, maxNotificationLines, maxLineChars),
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
          "Review the current Brewva session for a directory without entering a model turn (usage: /inspect [dir])",
        handler,
      });
    },
  });
}
