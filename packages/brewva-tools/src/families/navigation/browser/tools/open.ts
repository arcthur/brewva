import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolOptions } from "../../../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../../../registry/runtime-bound-tool.js";
import { okTextResult } from "../../../../utils/result.js";
import { getSessionId } from "../../../../utils/session.js";
import { enforceRuntimeToolAccess } from "../access.js";
import { executeBrowserCommand } from "../command.js";
import { buildFailureResult, buildStatusPayload, buildSuccessDetails } from "../render.js";
import { resolveBaseCwd, resolveBrowserSessionName } from "../session.js";
import type { BrowserToolDeps } from "../types.js";

export function createBrowserOpenTool(
  options: BrewvaBundledToolOptions,
  deps: BrowserToolDeps,
): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options.runtime, "browser_open");
  const scopedOptions = { ...options, runtime };
  return define({
    name: "browser_open",
    label: "Browser Open",
    description: "Open a URL in the managed agent-browser session.",
    parameters: Type.Object({
      url: Type.String({ minLength: 1 }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const sessionName = resolveBrowserSessionName(sessionId);
      const cwd = resolveBaseCwd(scopedOptions, ctx);
      const access = enforceRuntimeToolAccess({
        options: scopedOptions,
        sessionId,
        toolName: "browser_open",
        args: { url: params.url },
        cwd,
      });
      if (!access.allowed) {
        return access.result;
      }
      const result = await executeBrowserCommand(
        {
          sessionName,
          cwd,
          args: ["open", params.url],
          signal,
        },
        deps,
      );
      if (!result.ok) {
        return buildFailureResult("browser_open", result, { url: params.url });
      }
      return okTextResult(
        buildStatusPayload({
          header: "[Browser Open]",
          sessionName,
          status: "opened",
          extra: [`url: ${params.url}`],
        }),
        {
          ok: true,
          url: params.url,
          ...buildSuccessDetails(result),
        },
      );
    },
  });
}
