import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolOptions } from "../../../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../../../registry/runtime-bound-tool.js";
import { failTextResult, textResult } from "../../../../utils/result.js";
import { getSessionId } from "../../../../utils/session.js";
import { executeBrowserCommand } from "../command.js";
import { buildFailureResult, buildStatusPayload, buildSuccessDetails } from "../render.js";
import { BrowserLoadStateSchema, normalizeBrowserLoadState } from "../schemas.js";
import { resolveBaseCwd, resolveBrowserSessionName } from "../session.js";
import type { BrowserToolDeps } from "../types.js";

export function createBrowserWaitTool(
  options: BrewvaBundledToolOptions,
  deps: BrowserToolDeps,
): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options.runtime, "browser_wait");
  const scopedOptions = { ...options, runtime };
  return define({
    name: "browser_wait",
    label: "Browser Wait",
    description: "Wait for a load state or URL pattern in the managed browser session.",
    parameters: Type.Object({
      loadState: Type.Optional(BrowserLoadStateSchema),
      urlPattern: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (params.loadState && params.urlPattern) {
        return failTextResult(
          "[Browser Wait]\nstatus: failed\nreason: choose either loadState or urlPattern, not both.",
          {
            ok: false,
            reason: "wait_condition_conflict",
          },
        );
      }

      const sessionName = resolveBrowserSessionName(getSessionId(ctx));
      const cwd = resolveBaseCwd(scopedOptions, ctx);
      const loadState = normalizeBrowserLoadState(params.loadState) ?? "networkidle";
      const args = ["wait"];
      if (params.urlPattern) {
        args.push("--url", params.urlPattern);
      } else {
        args.push("--load", loadState);
      }

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
        return buildFailureResult("browser_wait", result, {
          loadState,
          urlPattern: params.urlPattern ?? null,
        });
      }
      return textResult(
        buildStatusPayload({
          header: "[Browser Wait]",
          sessionName,
          status: "ready",
          extra: params.urlPattern
            ? [`url_pattern: ${params.urlPattern}`]
            : [`load_state: ${loadState}`],
        }),
        {
          ok: true,
          loadState,
          urlPattern: params.urlPattern ?? null,
          ...buildSuccessDetails(result),
        },
      );
    },
  });
}
