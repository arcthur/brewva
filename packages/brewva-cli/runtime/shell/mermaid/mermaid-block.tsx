/** @jsxImportSource @opentui/solid */

import { Show, createMemo, createSignal } from "solid-js";
import { useRenderer } from "../../opentui/index.js";
import type { SessionPalette } from "../palette.js";
import { useShellRenderContext } from "../render-context.js";
import {
  mermaidTerminalGraphicsProfileFromOpenTui,
  renderMermaidWithRuntime,
  type MermaidRuntimeRenderArtifact,
} from "./runtime-renderer.js";

type ReadyMermaidRuntimeRenderArtifact = Extract<MermaidRuntimeRenderArtifact, { kind: "ready" }>;

export function MermaidBlock(input: { source: string; theme: SessionPalette }) {
  const renderer = useRenderer();
  const context = useShellRenderContext();
  const [hovered, setHovered] = createSignal(false);
  const artifact = createMemo(() =>
    renderMermaidWithRuntime({
      source: input.source,
      theme: input.theme,
      terminal: mermaidTerminalGraphicsProfileFromOpenTui(renderer.capabilities),
    }),
  );
  const readyArtifact = createMemo<ReadyMermaidRuntimeRenderArtifact | undefined>(() => {
    const current = artifact();
    return current.kind === "ready" ? current : undefined;
  });
  const failureReason = createMemo(() => {
    const current = artifact();
    return current.kind === "failed" ? current.reason : "unknown error";
  });
  const actionable = createMemo(() => Boolean(readyArtifact()));
  const inlineStatus = createMemo(() => formatInlineStatus(artifact()));
  const handleSelect = () => {
    if (renderer.getSelection()?.getSelectedText()) {
      return;
    }
    const current = readyArtifact();
    if (!current) {
      return;
    }
    void context.runtime.handleInput({
      type: "keymap.effect",
      effect: {
        type: "url.open",
        url: current.preview.url,
      },
    });
  };

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      border={["left"]}
      borderColor={hovered() && actionable() ? input.theme.accent : input.theme.borderSubtle}
      paddingLeft={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={hovered() && actionable() ? input.theme.backgroundElement : undefined}
      onMouseMove={() => setHovered(true)}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseUp={handleSelect}
    >
      <text fg={artifact().kind === "ready" ? input.theme.accent : input.theme.warning}>
        Mermaid diagram
      </text>
      <Show
        when={readyArtifact()}
        fallback={
          <text fg={input.theme.warning} paddingLeft={1} flexShrink={0}>
            Runtime preview unavailable: {failureReason()}
          </text>
        }
      >
        {(ready) => (
          <>
            <text fg={input.theme.text} paddingLeft={1} flexShrink={0}>
              Runtime preview ready
            </text>
            <text fg={input.theme.textMuted} paddingLeft={1} flexShrink={0}>
              {inlineStatus()}
            </text>
            <text
              fg={hovered() ? input.theme.accent : input.theme.textMuted}
              paddingLeft={1}
              flexShrink={0}
            >
              {hovered() ? "Click to open preview" : "Open preview"} - {ready().preview.displayPath}
            </text>
          </>
        )}
      </Show>
    </box>
  );
}

function formatInlineStatus(artifact: MermaidRuntimeRenderArtifact): string {
  if (artifact.inline.kind === "inline") {
    return `Inline terminal render: ${artifact.inline.protocol}`;
  }
  switch (artifact.inline.reason) {
    case "renderer_backend_unavailable":
      return "Inline terminal render unavailable: OpenTUI graphics backend is not wired yet";
    case "terminal_graphics_unavailable":
      return "Inline terminal render unavailable: terminal graphics are not available";
    default:
      artifact.inline.reason satisfies never;
      return "Inline terminal render unavailable";
  }
}
