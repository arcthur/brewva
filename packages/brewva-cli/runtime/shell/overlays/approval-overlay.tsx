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
import { useShellRenderContext } from "../render-context.js";
import { asRecord } from "../tool-render.js";
import { OverlaySurface } from "./frame.js";

type ApprovalDecisionShortcut = "allow" | "always" | "deny";

function approvalDetailValue(
  details: ReturnType<typeof buildOperatorSafetyShellAskView>["details"],
  key: "summary",
): string | undefined {
  return details.find((detail) => detail.key === key)?.value;
}

function approvalSummaryLabel(toolName: string): string {
  return toolName === "exec" ? "Command" : "Request";
}

function approvalShortcutInput(shortcut: ApprovalDecisionShortcut) {
  if (shortcut === "allow") {
    return {
      type: "keymap.effect" as const,
      effect: { type: "overlay.primary" as const },
    };
  }
  if (shortcut === "always") {
    return {
      key: "character",
      text: "w",
      ctrl: false,
      meta: false,
      shift: false,
    };
  }
  return {
    key: "character",
    text: "r",
    ctrl: false,
    meta: false,
    shift: false,
  };
}

function ApprovalActionButton(input: {
  label: string;
  shortcut: ApprovalDecisionShortcut;
  theme: SessionPalette;
  tone: "primary" | "secondary" | "danger";
}) {
  const ctx = useShellRenderContext();
  const backgroundColor =
    input.tone === "primary" ? input.theme.primary : input.theme.backgroundElement;
  const foregroundColor =
    input.tone === "primary"
      ? input.theme.selectionText
      : input.tone === "secondary"
        ? input.theme.success
        : input.theme.error;

  return (
    <box
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={backgroundColor}
      onMouseUp={(event) => {
        event.stopPropagation();
        void ctx.runtime.handleInput(approvalShortcutInput(input.shortcut));
      }}
    >
      <text fg={foregroundColor} attributes={TextAttributes.BOLD}>
        {input.label}
      </text>
    </box>
  );
}

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
      "Enter/A allow once",
      "W always allow",
      "R deny",
      "Esc close",
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
          <Show when={approvalDetailValue(safety()!.details, "summary")}>
            {(summary) => (
              <text fg={input.theme.text} wrapMode="word">
                {approvalSummaryLabel(safety()!.toolName)}: {summary()}
              </text>
            )}
          </Show>
          <text fg={input.theme.textMuted}>Tool: {safety()!.toolName}</text>
          <Show when={safety()!.effectSummary}>
            <text fg={input.theme.textMuted}>{safety()!.effectSummary}</text>
          </Show>
          <Show when={safety()!.riskSummary}>
            <text fg={input.theme.textMuted}>{safety()!.riskSummary}</text>
          </Show>
          <box flexDirection="row" gap={2}>
            <ApprovalActionButton
              label={`[A] ${safety()!.primaryActionLabel}`}
              shortcut="allow"
              tone="primary"
              theme={input.theme}
            />
            <ApprovalActionButton
              label="[W] Always allow"
              shortcut="always"
              tone="secondary"
              theme={input.theme}
            />
            <ApprovalActionButton
              label={`[R] ${safety()!.denyActionLabel}`}
              shortcut="deny"
              tone="danger"
              theme={input.theme}
            />
          </box>
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
