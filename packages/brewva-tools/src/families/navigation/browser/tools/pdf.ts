import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolOptions } from "../../../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../../../registry/runtime-bound-tool.js";
import { failTextResult, textResult } from "../../../../utils/result.js";
import { getSessionId } from "../../../../utils/session.js";
import { buildArtifact, resolveWritablePath } from "../artifacts.js";
import { executeBrowserCommand } from "../command.js";
import { buildFailureResult, buildStatusPayload, buildSuccessDetails } from "../render.js";
import { resolveBaseCwd, resolveBrowserSessionName, resolveWorkspaceRoot } from "../session.js";
import type { BrowserToolDeps } from "../types.js";

export function createBrowserPdfTool(
  options: BrewvaBundledToolOptions,
  deps: BrowserToolDeps,
): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options.runtime, "browser_pdf");
  const scopedOptions = { ...options, runtime };
  return define({
    name: "browser_pdf",
    label: "Browser PDF",
    description: "Render the current page to PDF and persist it in the workspace.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const sessionName = resolveBrowserSessionName(sessionId);
      const cwd = resolveBaseCwd(scopedOptions, ctx);
      const workspaceRoot = resolveWorkspaceRoot(scopedOptions);
      const path = resolveWritablePath({
        workspaceRoot,
        baseCwd: cwd,
        sessionId,
        toolName: "browser_pdf",
        toolCallId,
        requestedPath: params.path,
        defaultFileName: "page.pdf",
      });
      if (!path.ok) {
        return failTextResult(`[Browser PDF]\nstatus: failed\nreason: ${path.message}`, {
          ok: false,
          reason: path.reason,
          requestedPath: path.requestedPath,
        });
      }

      const result = await executeBrowserCommand(
        {
          sessionName,
          cwd,
          args: ["pdf", path.absolutePath],
          signal,
        },
        deps,
      );
      if (!result.ok) {
        return buildFailureResult("browser_pdf", result, {
          requestedPath: path.requestedPath,
          artifactRef: path.artifactRef,
        });
      }
      const artifact = buildArtifact("browser_pdf", path.artifactRef, path.absolutePath);
      return textResult(
        buildStatusPayload({
          header: "[Browser PDF]",
          sessionName,
          status: "saved",
          extra: [`artifact: ${path.artifactRef}`],
        }),
        {
          ok: true,
          artifactRef: path.artifactRef,
          artifacts: [artifact],
          requestedPath: path.requestedPath,
          ...buildSuccessDetails(result),
        },
      );
    },
  });
}
