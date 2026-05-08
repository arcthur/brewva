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

export function createBrowserDiffSnapshotTool(
  options: BrewvaBundledToolOptions,
  deps: BrowserToolDeps,
): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "browser_diff_snapshot",
  );
  const scopedOptions = { ...options, runtime };
  return define({
    name: "browser_diff_snapshot",
    label: "Browser Diff Snapshot",
    description:
      "Diff the current page against the last browser snapshot and persist the diff in the workspace.",
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
        toolName: "browser_diff_snapshot",
        toolCallId,
        requestedPath: params.path,
        defaultFileName: "diff-snapshot.txt",
      });
      if (!path.ok) {
        return failTextResult(`[Browser Diff Snapshot]\nstatus: failed\nreason: ${path.message}`, {
          ok: false,
          reason: path.reason,
          requestedPath: path.requestedPath,
        });
      }

      const result = await executeBrowserCommand(
        {
          sessionName,
          cwd,
          args: ["diff", "snapshot"],
          signal,
        },
        deps,
      );
      if (!result.ok) {
        return buildFailureResult("browser_diff_snapshot", result, {
          requestedPath: path.requestedPath,
          artifactRef: path.artifactRef,
        });
      }
      writeArtifactText(path.absolutePath, result.stdout);
      const artifact = buildTextArtifact("browser_diff_snapshot", path.artifactRef, result.stdout);
      return textResult(
        buildTextPayload({
          header: "[Browser Diff Snapshot]",
          sessionName,
          artifactRef: path.artifactRef,
          bodyLabel: "diff",
          bodyText: result.stdout,
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
