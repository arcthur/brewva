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

export function createBrowserStateSaveTool(
  options: BrewvaBundledToolOptions,
  deps: BrowserToolDeps,
): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "browser_state_save",
  );
  const scopedOptions = { ...options, runtime };
  return define({
    name: "browser_state_save",
    label: "Browser State Save",
    description: "Persist the current browser session state into the workspace.",
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
        toolName: "browser_state_save",
        toolCallId,
        requestedPath: params.path,
        defaultFileName: "state.json",
      });
      if (!path.ok) {
        return failTextResult(`[Browser State Save]\nstatus: failed\nreason: ${path.message}`, {
          ok: false,
          reason: path.reason,
          requestedPath: path.requestedPath,
        });
      }
      const result = await executeBrowserCommand(
        {
          sessionName,
          cwd,
          args: ["state", "save", path.absolutePath],
          signal,
        },
        deps,
      );
      if (!result.ok) {
        return buildFailureResult("browser_state_save", result, {
          requestedPath: path.requestedPath,
          artifactRef: path.artifactRef,
        });
      }
      const artifact = buildArtifact("browser_state", path.artifactRef, path.absolutePath);
      return textResult(
        buildStatusPayload({
          header: "[Browser State Save]",
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
