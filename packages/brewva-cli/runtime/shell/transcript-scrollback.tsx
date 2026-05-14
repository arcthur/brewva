/** @jsxImportSource @opentui/solid */

import type { BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import { renderOpenTuiScrollbackLines } from "@brewva/brewva-tui/internal-opentui-runtime";
import { For } from "solid-js";
import type { ShellRendererController } from "../../src/shell/domain/renderer-contract.js";
import { createPalette } from "./palette.js";
import { ShellRenderProvider } from "./render-context.js";
import { createToolRenderCache, type ToolRenderCache } from "./tool-render.js";
import { TranscriptMessageView } from "./transcript.js";

function TranscriptScrollbackDocument(input: {
  runtime: ShellRendererController;
  messages: ReturnType<ShellRendererController["getViewState"]>["transcript"]["messages"];
  toolDefinitions: ReadonlyMap<string, BrewvaToolDefinition>;
  toolRenderCache: ToolRenderCache;
  width: number;
}) {
  const viewState = input.runtime.getViewState();
  const theme = createPalette(viewState.theme);
  const sessionIdentity = input.runtime.getSessionIdentity();
  const transcriptWidth = Math.max(20, input.width - 8);
  const shellRenderContext = {
    runtime: input.runtime,
    diffStyle: () => viewState.diff.style,
    diffWrapMode: () => viewState.diff.wrapMode,
    showThinking: () => viewState.view.showThinking,
  };
  return (
    <ShellRenderProvider value={shellRenderContext}>
      <box flexDirection="column" paddingTop={1} paddingBottom={1}>
        <For each={input.messages}>
          {(message, index) => (
            <TranscriptMessageView
              message={message}
              theme={theme}
              toolDefinitions={input.toolDefinitions}
              toolRenderCache={input.toolRenderCache}
              transcriptWidth={transcriptWidth}
              showToolDetails={viewState.view.toolDetails}
              index={index()}
              isLast={index() === input.messages.length - 1}
              modelLabel={sessionIdentity.modelLabel}
            />
          )}
        </For>
      </box>
    </ShellRenderProvider>
  );
}

export async function renderCliTranscriptScrollbackLines(input: {
  runtime: ShellRendererController;
  width: number;
  toolRenderCache?: ToolRenderCache;
}): Promise<string[]> {
  const messages = input.runtime.getViewState().transcript.messages;
  if (messages.length === 0) {
    return [];
  }
  const toolRenderCache = input.toolRenderCache ?? createToolRenderCache();
  toolRenderCache.resetForSession(input.runtime.getSessionIdentity().sessionId);
  return await renderOpenTuiScrollbackLines(
    () => (
      <TranscriptScrollbackDocument
        runtime={input.runtime}
        messages={messages}
        toolDefinitions={input.runtime.getToolDefinitions()}
        toolRenderCache={toolRenderCache}
        width={input.width}
      />
    ),
    { width: input.width },
  );
}
