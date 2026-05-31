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

export function createBrowserFillTool(
  options: BrewvaBundledToolOptions,
  deps: BrowserToolDeps,
): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options.runtime, "browser_fill");
  const scopedOptions = { ...options, runtime };
  return define({
    name: "browser_fill",
    label: "Browser Fill",
    description: "Fill a snapshot ref with a value in the managed browser session.",
    parameters: Type.Object({
      ref: Type.String({ minLength: 1 }),
      value: Type.String(),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const sessionName = resolveBrowserSessionName(getSessionId(ctx));
      const cwd = resolveBaseCwd(scopedOptions, ctx);
      const result = await executeBrowserCommand(
        {
          sessionName,
          cwd,
          args: ["fill", params.ref, params.value],
          signal,
        },
        deps,
      );
      if (!result.ok) {
        return buildFailureResult("browser_fill", result, { ref: params.ref });
      }
      return okTextResult(
        buildStatusPayload({
          header: "[Browser Fill]",
          sessionName,
          status: "filled",
          extra: [`ref: ${params.ref}`, `value_chars: ${params.value.length}`],
        }),
        {
          ok: true,
          ref: params.ref,
          valueChars: params.value.length,
          ...buildSuccessDetails(result),
        },
      );
    },
  });
}
