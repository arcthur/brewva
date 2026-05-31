import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolOptions } from "../../../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../../../registry/runtime-bound-tool.js";
import { okTextResult } from "../../../../utils/result.js";
import { getSessionId } from "../../../../utils/session.js";
import { executeBrowserCommand } from "../command.js";
import { buildFailureResult, buildStatusPayload, buildSuccessDetails } from "../render.js";
import { resolveBaseCwd, resolveBrowserSessionName } from "../session.js";
import type { BrowserToolDeps } from "../types.js";

export function createBrowserClickTool(
  options: BrewvaBundledToolOptions,
  deps: BrowserToolDeps,
): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options.runtime, "browser_click");
  const scopedOptions = { ...options, runtime };
  return define({
    name: "browser_click",
    label: "Browser Click",
    description: "Click a snapshot ref in the managed browser session.",
    parameters: Type.Object({
      ref: Type.String({ minLength: 1 }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const sessionName = resolveBrowserSessionName(getSessionId(ctx));
      const cwd = resolveBaseCwd(scopedOptions, ctx);
      const result = await executeBrowserCommand(
        {
          sessionName,
          cwd,
          args: ["click", params.ref],
          signal,
        },
        deps,
      );
      if (!result.ok) {
        return buildFailureResult("browser_click", result, { ref: params.ref });
      }
      return okTextResult(
        buildStatusPayload({
          header: "[Browser Click]",
          sessionName,
          status: "clicked",
          extra: [`ref: ${params.ref}`],
        }),
        {
          ok: true,
          ref: params.ref,
          ...buildSuccessDetails(result),
        },
      );
    },
  });
}
