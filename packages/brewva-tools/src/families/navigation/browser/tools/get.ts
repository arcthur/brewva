import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolOptions } from "../../../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../../../registry/runtime-bound-tool.js";
import { errTextResult, okTextResult } from "../../../../utils/result.js";
import { getSessionId } from "../../../../utils/session.js";
import { buildTextArtifact, resolveWritablePath, writeArtifactText } from "../artifacts.js";
import { executeBrowserCommand } from "../command.js";
import { buildFailureResult, buildTextPayload, buildSuccessDetails } from "../render.js";
import { BrowserGetFieldSchema, normalizeBrowserGetField } from "../schemas.js";
import { resolveBaseCwd, resolveBrowserSessionName, resolveWorkspaceRoot } from "../session.js";
import type { BrowserToolDeps } from "../types.js";

export function createBrowserGetTool(
  options: BrewvaBundledToolOptions,
  deps: BrowserToolDeps,
): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options.runtime, "browser_get");
  const scopedOptions = { ...options, runtime };
  return define({
    name: "browser_get",
    label: "Browser Get",
    description: "Get a page title, URL, or rendered text from the managed browser session.",
    parameters: Type.Object({
      field: BrowserGetFieldSchema,
      selector: Type.Optional(Type.String({ minLength: 1 })),
      path: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const field = normalizeBrowserGetField(params.field);
      if (field !== "text" && params.selector) {
        return errTextResult(
          "[Browser Get]\nstatus: failed\nreason: selector is only valid when field=text.",
          {
            ok: false,
            reason: "selector_requires_text_field",
            field,
          },
        );
      }
      if (field !== "text" && params.path) {
        return errTextResult(
          "[Browser Get]\nstatus: failed\nreason: path is only valid when field=text.",
          {
            ok: false,
            reason: "path_requires_text_field",
            field,
          },
        );
      }

      const sessionId = getSessionId(ctx);
      const sessionName = resolveBrowserSessionName(sessionId);
      const cwd = resolveBaseCwd(scopedOptions, ctx);
      const workspaceRoot = resolveWorkspaceRoot(scopedOptions);
      const artifactPath =
        field === "text"
          ? resolveWritablePath({
              workspaceRoot,
              baseCwd: cwd,
              sessionId,
              toolName: "browser_get",
              toolCallId,
              requestedPath: params.path,
              defaultFileName: "text.txt",
            })
          : null;
      if (artifactPath && !artifactPath.ok) {
        return errTextResult(`[Browser Get]\nstatus: failed\nreason: ${artifactPath.message}`, {
          ok: false,
          reason: artifactPath.reason,
          requestedPath: artifactPath.requestedPath,
          field,
        });
      }
      const args = ["get", field];
      if (params.selector) {
        args.push(params.selector);
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
        return buildFailureResult("browser_get", result, {
          field,
          selector: params.selector ?? null,
        });
      }
      if (field === "text" && artifactPath) {
        writeArtifactText(artifactPath.absolutePath, result.stdout);
        const artifact = buildTextArtifact(
          "browser_get_text",
          artifactPath.artifactRef,
          result.stdout,
        );
        return okTextResult(
          buildTextPayload({
            header: "[Browser Get]",
            sessionName,
            artifactRef: artifactPath.artifactRef,
            bodyLabel: field,
            bodyText: result.stdout,
            extra: params.selector ? [`selector: ${params.selector}`] : [`field: ${field}`],
          }),
          {
            ok: true,
            field,
            selector: params.selector ?? null,
            artifactRef: artifactPath.artifactRef,
            artifacts: [artifact],
            requestedPath: artifactPath.requestedPath,
            ...buildSuccessDetails(result),
          },
        );
      }
      return okTextResult(
        buildTextPayload({
          header: "[Browser Get]",
          sessionName,
          bodyLabel: field,
          bodyText: result.stdout,
          extra: params.selector ? [`selector: ${params.selector}`] : [`field: ${field}`],
        }),
        {
          ok: true,
          field,
          selector: params.selector ?? null,
          ...buildSuccessDetails(result),
        },
      );
    },
  });
}
