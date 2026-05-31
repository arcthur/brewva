import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolOptions } from "../../../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../../../registry/runtime-bound-tool.js";
import { errTextResult, okTextResult } from "../../../../utils/result.js";
import { getSessionId } from "../../../../utils/session.js";
import { resolveExistingPath } from "../artifacts.js";
import { executeBrowserCommand } from "../command.js";
import { buildFailureResult, buildStatusPayload, buildSuccessDetails } from "../render.js";
import { resolveBaseCwd, resolveBrowserSessionName, resolveWorkspaceRoot } from "../session.js";
import type { BrowserToolDeps } from "../types.js";

export function createBrowserStateLoadTool(
  options: BrewvaBundledToolOptions,
  deps: BrowserToolDeps,
): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "browser_state_load",
  );
  const scopedOptions = { ...options, runtime };
  return define({
    name: "browser_state_load",
    label: "Browser State Load",
    description: "Load a saved browser session state file from the workspace.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const sessionName = resolveBrowserSessionName(getSessionId(ctx));
      const cwd = resolveBaseCwd(scopedOptions, ctx);
      const workspaceRoot = resolveWorkspaceRoot(scopedOptions);
      const path = resolveExistingPath({
        workspaceRoot,
        baseCwd: cwd,
        requestedPath: params.path,
      });
      if (!path.ok) {
        return errTextResult(`[Browser State Load]\nstatus: failed\nreason: ${path.message}`, {
          ok: false,
          reason: path.reason,
          requestedPath: path.requestedPath,
        });
      }
      const result = await executeBrowserCommand(
        {
          sessionName,
          cwd,
          args: ["state", "load", path.absolutePath],
          signal,
        },
        deps,
      );
      if (!result.ok) {
        return buildFailureResult("browser_state_load", result, {
          requestedPath: path.requestedPath,
          artifactRef: path.artifactRef,
        });
      }
      return okTextResult(
        buildStatusPayload({
          header: "[Browser State Load]",
          sessionName,
          status: "loaded",
          extra: [`path: ${path.artifactRef}`],
        }),
        {
          ok: true,
          artifactRef: path.artifactRef,
          requestedPath: path.requestedPath,
          ...buildSuccessDetails(result),
        },
      );
    },
  });
}
