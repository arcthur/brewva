/** @jsxImportSource @opentui/solid */

import { For, Show, createMemo } from "solid-js";
import {
  buildOperatorSafetyShellAskEmptyView,
  buildOperatorSafetyShellAskView,
} from "../../../src/shell/domain/operator-safety/shell-view.js";
import type { CliApprovalOverlayPayload } from "../../../src/shell/domain/overlays/payloads.js";
import { TextAttributes } from "../../opentui/index.js";
import { DiffView } from "../diff-view.js";
import type { SessionPalette } from "../palette.js";
import { asRecord } from "../tool-render.js";
import { OverlaySurface } from "./frame.js";

export function ApprovalOverlay(input: {
  payload: CliApprovalOverlayPayload;
  width: number;
  height: number;
  theme: SessionPalette;
}) {
  const request = createMemo(() => input.payload.snapshot.approvals[input.payload.selectedIndex]);
  const empty = buildOperatorSafetyShellAskEmptyView();
  const safety = createMemo(() => {
    const current = request();
    return current ? buildOperatorSafetyShellAskView({ request: current }) : undefined;
  });
  const diffPreview = createMemo(() => {
    const preview = asRecord(asRecord(request())?.diffPreview);
    if (preview?.kind !== "diff") {
      return undefined;
    }
    const path = typeof preview.path === "string" ? preview.path : undefined;
    const diff = typeof preview.diff === "string" ? preview.diff : undefined;
    return path && diff ? { path, diff } : undefined;
  });
  const previewTitle = createMemo(() => {
    const preview = diffPreview();
    if (!preview) {
      return undefined;
    }
    const toolName = request()?.toolName;
    const verb = toolName === "edit" ? "Edit" : toolName === "write" ? "Write" : "Patch";
    return `${verb} ${preview.path}`;
  });
  const addedPreviewLines = createMemo(() =>
    (diffPreview()?.diff ?? "")
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .slice(0, 3)
      .map((line, index) => `${index + 1} + ${line.slice(1).trimStart()}`),
  );
  const footer = createMemo(() =>
    [
      diffPreview() ? `ctrl+f ${input.payload.previewExpanded ? "minimize" : "fullscreen"}` : "",
      "enter confirm",
      "r reject",
      "esc close",
    ]
      .filter(Boolean)
      .join(" | "),
  );

  return (
    <OverlaySurface
      title={safety()?.title ?? empty.title}
      width={input.width}
      height={input.height}
      theme={input.theme}
      footer={footer()}
    >
      <Show
        when={request()}
        fallback={
          <box flexDirection="column" gap={1}>
            <text fg={input.theme.text} attributes={TextAttributes.BOLD}>
              {empty.title}
            </text>
            <text fg={input.theme.textMuted}>{empty.headline}</text>
            <Show when={empty.subline}>
              <text fg={input.theme.textMuted}>{empty.subline}</text>
            </Show>
          </box>
        }
      >
        <box flexDirection="column" gap={1}>
          <text fg={input.theme.warning} attributes={TextAttributes.BOLD}>
            {safety()!.subject}
          </text>
          <text fg={input.theme.text}>{safety()!.headline}</text>
          <Show when={safety()!.subline}>
            <text fg={input.theme.textMuted}>{safety()!.subline}</text>
          </Show>
          <box flexDirection="row" gap={2}>
            <text fg={input.theme.success}>{safety()!.primaryActionLabel}</text>
            <text fg={input.theme.error}>{safety()!.denyActionLabel}</text>
          </box>
          <For each={safety()!.details}>
            {(detail) => (
              <text fg={input.theme.textMuted} wrapMode="word">
                {detail.label}: {detail.value}
              </text>
            )}
          </For>
          <Show when={diffPreview()}>
            {(preview) => (
              <box flexDirection="column" gap={1} marginTop={1}>
                <text fg={input.theme.text} attributes={TextAttributes.BOLD}>
                  {previewTitle()}
                  {addedPreviewLines()[0] ? ` | ${addedPreviewLines()[0]}` : ""}
                </text>
                <text fg={input.theme.textMuted}>
                  ctrl+f {input.payload.previewExpanded ? "minimize" : "fullscreen"}
                </text>
                <For each={addedPreviewLines()}>
                  {(line) => <text fg={input.theme.success}>{line}</text>}
                </For>
                <DiffView
                  diff={preview().diff}
                  filePath={preview().path}
                  width={input.width}
                  style="stacked"
                  wrapMode="word"
                  theme={input.theme}
                />
              </box>
            )}
          </Show>
        </box>
      </Show>
    </OverlaySurface>
  );
}
