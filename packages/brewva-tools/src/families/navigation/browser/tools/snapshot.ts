import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolOptions } from "../../../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../../../registry/runtime-bound-tool.js";
import { failTextResult, textResult } from "../../../../utils/result.js";
import { getSessionId } from "../../../../utils/session.js";
import { buildTextArtifact, resolveWritablePath, writeArtifactText } from "../artifacts.js";
import { executeBrowserCommand } from "../command.js";
import { buildFailureResult, buildTextPayload, buildSuccessDetails } from "../render.js";
import { resolveBaseCwd, resolveBrowserSessionName, resolveWorkspaceRoot } from "../session.js";
import type { BrowserToolDeps } from "../types.js";

export function createBrowserSnapshotTool(
  options: BrewvaBundledToolOptions,
  deps: BrowserToolDeps,
): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "browser_snapshot",
  );
  const scopedOptions = { ...options, runtime };
  return define({
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description: "Capture a DOM/text snapshot from the managed browser session.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ minLength: 1 })),
      interactive: Type.Optional(Type.Boolean({ default: true })),
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
        toolName: "browser_snapshot",
        toolCallId,
        requestedPath: params.path,
        defaultFileName: "snapshot.txt",
      });
      if (!path.ok) {
        return failTextResult(`[Browser Snapshot]\nstatus: failed\nreason: ${path.message}`, {
          ok: false,
          reason: path.reason,
          requestedPath: path.requestedPath,
        });
      }

      const args = ["snapshot"];
      if (params.interactive !== false) {
        args.push("-i");
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
        return buildFailureResult("browser_snapshot", result, {
          requestedPath: path.requestedPath,
          artifactRef: path.artifactRef,
        });
      }

      writeArtifactText(path.absolutePath, result.stdout);
      const artifact = buildTextArtifact("browser_snapshot", path.artifactRef, result.stdout);
      return textResult(
        buildTextPayload({
          header: "[Browser Snapshot]",
          sessionName,
          artifactRef: path.artifactRef,
          bodyLabel: "snapshot",
          bodyText: result.stdout,
          extra: [`interactive: ${params.interactive !== false ? "true" : "false"}`],
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
