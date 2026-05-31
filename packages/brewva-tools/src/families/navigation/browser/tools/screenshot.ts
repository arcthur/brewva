import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolOptions } from "../../../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../../../registry/runtime-bound-tool.js";
import { errTextResult, okTextResult } from "../../../../utils/result.js";
import { getSessionId } from "../../../../utils/session.js";
import { buildArtifact, resolveWritablePath } from "../artifacts.js";
import { executeBrowserCommand } from "../command.js";
import { buildFailureResult, buildStatusPayload, buildSuccessDetails } from "../render.js";
import { resolveBaseCwd, resolveBrowserSessionName, resolveWorkspaceRoot } from "../session.js";
import type { BrowserToolDeps } from "../types.js";

export function createBrowserScreenshotTool(
  options: BrewvaBundledToolOptions,
  deps: BrowserToolDeps,
): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "browser_screenshot",
  );
  const scopedOptions = { ...options, runtime };
  return define({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description:
      "Capture a screenshot from the managed browser session and persist it in the workspace.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ minLength: 1 })),
      fullPage: Type.Optional(Type.Boolean({ default: false })),
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
        toolName: "browser_screenshot",
        toolCallId,
        requestedPath: params.path,
        defaultFileName: "screenshot.png",
      });
      if (!path.ok) {
        return errTextResult(`[Browser Screenshot]\nstatus: failed\nreason: ${path.message}`, {
          ok: false,
          reason: path.reason,
          requestedPath: path.requestedPath,
        });
      }
      const args = ["screenshot"];
      if (params.fullPage) {
        args.push("--full");
      }
      args.push(path.absolutePath);
      const result = await executeBrowserCommand(
        {
          sessionName,
          cwd,
          args,
          signal,
        },
        deps,
      );
      if (!result.ok) {
        return buildFailureResult("browser_screenshot", result, {
          requestedPath: path.requestedPath,
          artifactRef: path.artifactRef,
        });
      }
      const artifact = buildArtifact("browser_screenshot", path.artifactRef, path.absolutePath);
      return okTextResult(
        buildStatusPayload({
          header: "[Browser Screenshot]",
          sessionName,
          status: "saved",
          extra: [
            `artifact: ${path.artifactRef}`,
            `full_page: ${params.fullPage ? "true" : "false"}`,
          ],
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
