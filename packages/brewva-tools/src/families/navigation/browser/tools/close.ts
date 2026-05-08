import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolOptions } from "../../../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../../../registry/runtime-bound-tool.js";
import { textResult } from "../../../../utils/result.js";
import { getSessionId } from "../../../../utils/session.js";
import { executeBrowserCommand } from "../command.js";
import { buildFailureResult, buildStatusPayload, buildSuccessDetails } from "../render.js";
import { resolveBaseCwd, resolveBrowserSessionName } from "../session.js";
import type { BrowserToolDeps } from "../types.js";

export function createBrowserCloseTool(
  options: BrewvaBundledToolOptions,
  deps: BrowserToolDeps,
): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options.runtime, "browser_close");
  const scopedOptions = { ...options, runtime };
  return define({
    name: "browser_close",
    label: "Browser Close",
    description: "Close the managed browser session.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const sessionName = resolveBrowserSessionName(getSessionId(ctx));
      const cwd = resolveBaseCwd(scopedOptions, ctx);
      const result = await executeBrowserCommand(
        {
          sessionName,
          cwd,
          args: ["close"],
          signal,
        },
        deps,
      );
      if (!result.ok) {
        return buildFailureResult("browser_close", result);
      }
      return textResult(
        buildStatusPayload({
          header: "[Browser Close]",
          sessionName,
          status: "closed",
        }),
        {
          ok: true,
          ...buildSuccessDetails(result),
        },
      );
    },
  });
}
