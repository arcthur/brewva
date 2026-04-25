/** @jsxImportSource @opentui/solid */

import type { OpenTuiScrollBoxHandle } from "@brewva/brewva-tui/internal-opentui-runtime";
import { useTerminalDimensions } from "@opentui/solid";
import type { JSX } from "solid-js";
import { For, Show, createEffect, createMemo } from "solid-js";
import {
  countQuestionRequestKinds,
  isImmediateQuestionRequest,
  normalizeQuestionDraftState,
  resolveQuestionOverlayTitle,
  questionRequestsFromOverlay,
  questionTabCount,
} from "../../src/shell/question-utils.js";
import type { CliShellRuntime } from "../../src/shell/runtime.js";
import {
  buildTrustLoopApprovalEmptyProjection,
  buildTrustLoopApprovalProjection,
  type TrustLoopDetailKey,
} from "../../src/shell/trust-loop/projection.js";
import type {
  CliApprovalOverlayPayload,
  CliQuestionOverlayPayload,
} from "../../src/shell/types.js";
import { DiffView, formatDiffFileTitle } from "./diff-view.js";
import { DIALOG_Z_INDEX } from "./overlay-style.js";
import { DEFAULT_SCROLL_ACCELERATION, SPLIT_BORDER_CHARS, type SessionPalette } from "./palette.js";
import { useShellRenderContext } from "./render-context.js";
import {
  asRecord,
  readDiffPayloadFromDetails,
  readDiffSourceRecordFromDetails,
} from "./tool-render.js";

export function PromptActionChip(input: {
  label: string;
  active?: boolean;
  theme: SessionPalette;
  onSelect?: () => void;
}) {
  return (
    <box
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={input.active ? input.theme.warning : input.theme.backgroundMenu}
      onMouseUp={() => input.onSelect?.()}
    >
      <text fg={input.active ? input.theme.selectionText : input.theme.textMuted}>
        {input.label}
      </text>
    </box>
  );
}

function InlinePromptCard(input: {
  title: string;
  theme: SessionPalette;
  accentColor: string;
  expanded?: boolean;
  header?: JSX.Element;
  body: JSX.Element;
  actions: ReadonlyArray<{
    label: string;
    active?: boolean;
    onSelect?: () => void;
  }>;
  hints: readonly string[];
}) {
  const dimensions = useTerminalDimensions();
  const narrow = createMemo(() => dimensions().width < 90);
  return (
    <box
      backgroundColor={input.theme.backgroundPanel}
      border={["left"]}
      borderColor={input.accentColor}
      customBorderChars={SPLIT_BORDER_CHARS}
      flexDirection="column"
      zIndex={input.expanded ? DIALOG_Z_INDEX - 1 : undefined}
      {...(input.expanded
        ? {
            position: "absolute",
            top: 0,
            bottom: 1,
            left: 0,
            right: 0,
          }
        : {
            position: "relative",
            maxHeight: 15,
          })}
    >
      <box
        gap={1}
        paddingLeft={1}
        paddingRight={3}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
        flexGrow={input.expanded ? 1 : undefined}
        flexShrink={input.expanded ? 1 : 0}
      >
        <Show
          when={input.header}
          fallback={
            <box flexDirection="row" gap={1} paddingLeft={1} flexShrink={0}>
              <text fg={input.accentColor}>△</text>
              <text fg={input.theme.text}>{input.title}</text>
            </box>
          }
        >
          <box paddingLeft={1} flexShrink={0}>
            {input.header}
          </box>
        </Show>
        {input.body}
      </box>
      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        gap={1}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={input.theme.backgroundElement}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
      >
        <box flexDirection="row" gap={1} flexShrink={0}>
          <For each={input.actions}>
            {(action) => (
              <PromptActionChip
                label={action.label}
                active={action.active}
                theme={input.theme}
                onSelect={action.onSelect}
              />
            )}
          </For>
        </box>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <For each={input.hints}>{(hint) => <text fg={input.theme.textMuted}>{hint}</text>}</For>
        </box>
      </box>
    </box>
  );
}

export function InlineApprovalPrompt(input: {
  runtime: CliShellRuntime;
  payload: CliApprovalOverlayPayload;
  theme: SessionPalette;
  transcriptWidth: number;
}) {
  let previewScrollbox: OpenTuiScrollBoxHandle | undefined;
  const shellContext = useShellRenderContext();
  const dimensions = useTerminalDimensions();
  const request = createMemo(() => input.payload.snapshot.approvals[input.payload.selectedIndex]);
  const emptyTrust = buildTrustLoopApprovalEmptyProjection();
  const trust = createMemo(() => {
    const current = request();
    return current ? buildTrustLoopApprovalProjection({ request: current }) : undefined;
  });
  const approvalSubject = createMemo(() => trust()?.subject ?? "effect");
  const approvalActionText = createMemo(
    () =>
      `${trust()?.primaryActionLabel ?? "Authorize once"} · ${
        trust()?.rejectActionLabel ?? "Reject"
      }`,
  );
  const detailValue = (key: TrustLoopDetailKey): string | undefined =>
    trust()?.details.find((row) => row.key === key)?.value;
  const approvalDetailLines = createMemo(() => {
    const currentTrust = trust();
    const tool = currentTrust?.toolName;
    const boundary = currentTrust?.boundary;
    const summary = detailValue("summary");
    const effects = detailValue("effects");
    const receipt = detailValue("receipt");
    const recovery = detailValue("recovery");
    return [
      summary ? `Summary: ${summary}` : undefined,
      [
        tool ? `Tool: ${tool}` : undefined,
        boundary ? `Boundary: ${boundary}` : undefined,
        effects ? `Effects: ${effects}` : undefined,
        receipt ? `Receipt: ${receipt}` : undefined,
        recovery ? `Recovery: ${recovery}` : undefined,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" · "),
    ].filter((line): line is string => typeof line === "string" && line.length > 0);
  });
  const previewRecord = createMemo(() => {
    const record = asRecord(request());
    return readDiffSourceRecordFromDetails(record);
  });
  const diffPayload = createMemo(() => {
    const preview = previewRecord();
    const path =
      typeof preview?.filePath === "string"
        ? preview.filePath
        : typeof preview?.path === "string"
          ? preview.path
          : undefined;
    return readDiffPayloadFromDetails(preview, path);
  });
  const singleDiff = createMemo(() => {
    const current = diffPayload();
    return current?.kind === "single" ? current : undefined;
  });
  const diffFiles = createMemo(() => {
    const current = diffPayload();
    return current?.kind === "files" ? current.files : [];
  });
  const previewError = createMemo(() => {
    const value = previewRecord()?.error;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  });
  const previewPath = createMemo(
    () =>
      singleDiff()?.path ??
      diffFiles()[0]?.displayPath ??
      (typeof previewRecord()?.path === "string" ? (previewRecord()?.path as string) : undefined),
  );
  const hasPreviewBody = createMemo(
    () => Boolean(singleDiff()) || diffFiles().length > 0 || Boolean(previewError()),
  );
  const previewToggleHint = createMemo(
    () => `ctrl+f ${input.payload.previewExpanded ? "minimize" : "fullscreen"}`,
  );
  const previewHeight = createMemo(() => {
    if (input.payload.previewExpanded) {
      return Math.max(6, dimensions().height - 12);
    }
    return Math.max(5, Math.min(10, Math.floor((dimensions().height - 24) / 3)));
  });
  createEffect(() => {
    const node = previewScrollbox;
    if (!node || node.isDestroyed) {
      return;
    }
    node.scrollTop = Math.max(0, input.payload.previewScrollOffset ?? 0);
  });
  return (
    <Show
      when={request()}
      fallback={
        <InlinePromptCard
          title={emptyTrust.title}
          theme={input.theme}
          accentColor={input.theme.borderActive}
          body={
            <box paddingLeft={1} flexDirection="column" gap={1}>
              <text fg={input.theme.text}>{emptyTrust.headline}</text>
              <text fg={input.theme.textMuted}>{emptyTrust.subline}</text>
            </box>
          }
          actions={[]}
          hints={["esc close"]}
        />
      }
    >
      {(entry) => {
        void entry;
        return (
          <InlinePromptCard
            title={trust()?.title ?? "Authorize effect"}
            theme={input.theme}
            accentColor={input.theme.warning}
            expanded={input.payload.previewExpanded}
            header={
              <box flexDirection="column" gap={0}>
                <box flexDirection="row" gap={1} flexShrink={0}>
                  <text fg={input.theme.warning}>△</text>
                  <text fg={input.theme.text}>{trust()?.title ?? "Authorize effect"}</text>
                </box>
                <Show when={trust()?.headline}>
                  {(headline) => (
                    <text fg={input.theme.text} paddingLeft={2}>
                      {headline()}
                    </text>
                  )}
                </Show>
                <Show when={trust()?.subline}>
                  {(subline) => (
                    <text fg={input.theme.textMuted} paddingLeft={2}>
                      {subline()}
                    </text>
                  )}
                </Show>
                <box flexDirection="row" gap={1} paddingLeft={2} flexShrink={0}>
                  <text fg={input.theme.textMuted} flexShrink={0}>
                    {hasPreviewBody() ? "→" : "•"}
                  </text>
                  <text fg={input.theme.text}>
                    {hasPreviewBody()
                      ? `Edit ${previewPath() ?? approvalSubject()} · ${previewToggleHint()}`
                      : `${approvalSubject()} · ${approvalActionText()}`}
                  </text>
                </box>
              </box>
            }
            body={
              <box paddingLeft={1} flexDirection="column" gap={1}>
                <box flexDirection="column" gap={0}>
                  <Show when={!hasPreviewBody()}>
                    <For each={approvalDetailLines()}>
                      {(line) => <text fg={input.theme.textMuted}>{line}</text>}
                    </For>
                  </Show>
                </box>
                <Show when={hasPreviewBody()} fallback={<></>}>
                  <scrollbox
                    ref={(node: OpenTuiScrollBoxHandle) => {
                      previewScrollbox = node;
                    }}
                    height={previewHeight()}
                    backgroundColor={input.theme.backgroundPanel}
                    scrollAcceleration={DEFAULT_SCROLL_ACCELERATION}
                    verticalScrollbarOptions={{
                      trackOptions: {
                        backgroundColor: input.theme.backgroundElement,
                        foregroundColor: input.theme.borderActive,
                      },
                    }}
                  >
                    <Show when={previewError()}>
                      <box paddingLeft={1} paddingRight={1}>
                        <text fg={input.theme.warning}>{previewError()}</text>
                      </box>
                    </Show>
                    <Show when={singleDiff()}>
                      <DiffView
                        diff={singleDiff()?.diff ?? ""}
                        filePath={singleDiff()?.path}
                        width={input.transcriptWidth}
                        style={shellContext.diffStyle()}
                        wrapMode={shellContext.diffWrapMode()}
                        theme={input.theme}
                      />
                    </Show>
                    <Show when={diffFiles().length > 0}>
                      <box flexDirection="column" gap={1}>
                        <For each={diffFiles()}>
                          {(file) => (
                            <box flexDirection="column" gap={1}>
                              <text fg={input.theme.textMuted}>{formatDiffFileTitle(file)}</text>
                              <Show
                                when={file.diff.length > 0}
                                fallback={
                                  <text fg={input.theme.diffRemoved}>
                                    -{file.deletions ?? 0} lines
                                  </text>
                                }
                              >
                                <DiffView
                                  diff={file.diff}
                                  filePath={file.path}
                                  width={input.transcriptWidth}
                                  style={shellContext.diffStyle()}
                                  wrapMode={shellContext.diffWrapMode()}
                                  theme={input.theme}
                                />
                              </Show>
                            </box>
                          )}
                        </For>
                      </box>
                    </Show>
                  </scrollbox>
                </Show>
              </box>
            }
            actions={[
              {
                label: trust()?.primaryActionLabel ?? "Authorize once",
                active: true,
                onSelect: () => {
                  void input.runtime.handleInput({
                    key: "enter",
                    ctrl: false,
                    meta: false,
                    shift: false,
                  });
                },
              },
              {
                label: trust()?.rejectActionLabel ?? "Reject",
                onSelect: () => {
                  void input.runtime.handleInput({
                    key: "character",
                    text: "r",
                    ctrl: false,
                    meta: false,
                    shift: false,
                  });
                },
              },
            ]}
            hints={[
              hasPreviewBody() ? previewToggleHint() : "",
              "⇆ select",
              "enter confirm",
              "r reject",
              "esc close",
            ].filter(Boolean)}
          />
        );
      }}
    </Show>
  );
}

export function InlineQuestionPrompt(input: {
  runtime: CliShellRuntime;
  payload: CliQuestionOverlayPayload;
  theme: SessionPalette;
}) {
  const requests = createMemo(() => questionRequestsFromOverlay(input.payload));
  const request = createMemo(() => {
    const items = requests();
    if (items.length === 0) {
      return undefined;
    }
    const index = Math.max(0, Math.min(input.payload.selectedIndex, items.length - 1));
    return items[index];
  });
  const draft = createMemo(() => {
    const current = request();
    if (!current) {
      return undefined;
    }
    return normalizeQuestionDraftState(
      current,
      input.payload.draftsByRequestId?.[current.requestId],
    );
  });
  const confirmTab = createMemo(() => {
    const current = request();
    const currentDraft = draft();
    if (!current || !currentDraft) {
      return false;
    }
    return (
      !isImmediateQuestionRequest(current) &&
      currentDraft.activeTabIndex === current.questions.length
    );
  });
  const question = createMemo(() => {
    const current = request();
    const currentDraft = draft();
    if (!current || !currentDraft || confirmTab()) {
      return undefined;
    }
    const index = Math.min(currentDraft.activeTabIndex, Math.max(0, current.questions.length - 1));
    return current.questions[index];
  });
  const answerSummary = createMemo(() => {
    const current = request();
    const currentDraft = draft();
    if (!current || !currentDraft) {
      return [];
    }
    return current.questions.map((entry, index) => ({
      header: entry.header,
      answer:
        (currentDraft.answers[index] ?? []).filter((value) => value.trim().length > 0).join(", ") ||
        "Pending",
    }));
  });
  const optionCount = createMemo(() => {
    const current = question();
    return current ? current.options.length + (current.custom !== false ? 1 : 0) : 0;
  });
  const customIndex = createMemo(() => {
    const current = question();
    return current ? current.options.length : -1;
  });
  const total = createMemo(() => requests().length);
  const requestKindCounts = createMemo(() => countQuestionRequestKinds(requests()));
  return (
    <Show
      when={request()}
      fallback={
        <InlinePromptCard
          title={resolveQuestionOverlayTitle(input.payload)}
          theme={input.theme}
          accentColor={input.theme.borderActive}
          body={
            <box paddingLeft={1} flexDirection="column" gap={1}>
              <text fg={input.theme.text}>No pending operator input.</text>
              <text fg={input.theme.textMuted}>
                {input.payload.mode === "interactive"
                  ? "The active tool will pause here until you answer or dismiss this request."
                  : "Brewva will show pending input requests and follow-up questions here when a run needs your input."}
              </text>
            </box>
          }
          actions={[]}
          hints={["esc close"]}
        />
      }
    >
      {(currentRequest) => (
        <InlinePromptCard
          title={resolveQuestionOverlayTitle(input.payload)}
          theme={input.theme}
          accentColor={input.theme.warning}
          header={
            <box flexDirection="column" gap={1}>
              <Show when={total() > 1}>
                <box flexDirection="row" gap={1}>
                  <For each={requests()}>
                    {(candidate, index) => (
                      <PromptActionChip
                        label={candidate.questions[0]?.header ?? `R${index() + 1}`}
                        active={index() === input.payload.selectedIndex}
                        theme={input.theme}
                      />
                    )}
                  </For>
                </box>
              </Show>
              <Show when={!isImmediateQuestionRequest(currentRequest())}>
                <box flexDirection="row" gap={1}>
                  <For each={currentRequest().questions}>
                    {(candidate, index) => (
                      <PromptActionChip
                        label={candidate.header}
                        active={draft()?.activeTabIndex === index()}
                        theme={input.theme}
                      />
                    )}
                  </For>
                  <PromptActionChip label="Review" active={confirmTab()} theme={input.theme} />
                </box>
              </Show>
              <Show when={input.payload.mode === "operator"}>
                <text fg={input.theme.textMuted}>
                  {`Input requests ${requestKindCounts().inputRequestCount} · Follow-up questions ${requestKindCounts().followUpCount}`}
                </text>
              </Show>
              <box flexDirection="row" gap={1}>
                <text fg={input.theme.warning}>△</text>
                <text fg={input.theme.text}>
                  {confirmTab() ? "Review answers" : currentRequest().sourceLabel}
                </text>
              </box>
            </box>
          }
          body={
            <box paddingLeft={1} flexDirection="column" gap={1}>
              <Show
                when={!confirmTab()}
                fallback={
                  <box flexDirection="column" gap={1}>
                    <text fg={input.theme.text}>Review the answers before continuing.</text>
                    <For each={answerSummary()}>
                      {(entry) => (
                        <box flexDirection="column" gap={0}>
                          <text fg={input.theme.text}>{entry.header}</text>
                          <text fg={input.theme.textMuted}>{entry.answer}</text>
                        </box>
                      )}
                    </For>
                  </box>
                }
              >
                <box flexDirection="column" gap={1}>
                  <text fg={input.theme.text}>
                    {question()?.questionText}
                    {question()?.multiple ? " (select all that apply)" : ""}
                  </text>
                  <text fg={input.theme.textMuted}>
                    {question()?.multiple
                      ? "Select one or more answers, then move to Review."
                      : "Select one answer to continue."}
                  </text>
                  <For each={question()?.options ?? []}>
                    {(option, index) => {
                      const selected = (
                        draft()?.answers[draft()?.activeTabIndex ?? 0] ?? []
                      ).includes(option.label);
                      const focused = draft()?.selectedOptionIndex === index();
                      const marker = question()?.multiple
                        ? selected
                          ? "[x]"
                          : "[ ]"
                        : selected
                          ? "(*)"
                          : "( )";
                      return (
                        <box flexDirection="column" gap={0}>
                          <box backgroundColor={focused ? input.theme.warning : undefined}>
                            <text
                              fg={
                                focused
                                  ? input.theme.selectionText
                                  : selected
                                    ? input.theme.text
                                    : input.theme.textMuted
                              }
                            >
                              {`${index() + 1}. ${marker} ${option.label}`}
                            </text>
                          </box>
                          <Show when={option.description}>
                            <text fg={input.theme.textMuted}>{option.description}</text>
                          </Show>
                        </box>
                      );
                    }}
                  </For>
                  <Show when={question()?.custom !== false}>
                    <box flexDirection="column" gap={0}>
                      <box
                        backgroundColor={
                          draft()?.selectedOptionIndex === customIndex()
                            ? input.theme.warning
                            : undefined
                        }
                      >
                        <text
                          fg={
                            draft()?.selectedOptionIndex === customIndex()
                              ? input.theme.selectionText
                              : input.theme.textMuted
                          }
                        >
                          {`${(question()?.options.length ?? 0) + 1}. ${
                            question()?.multiple
                              ? (draft()?.answers[draft()?.activeTabIndex ?? 0] ?? []).includes(
                                  draft()?.customAnswers[draft()?.activeTabIndex ?? 0] ?? "",
                                )
                                ? "[x]"
                                : "[ ]"
                              : (draft()?.answers[draft()?.activeTabIndex ?? 0]?.[0] ?? "") ===
                                  (draft()?.customAnswers[draft()?.activeTabIndex ?? 0] ?? "")
                                ? "(*)"
                                : "( )"
                          } Custom`}
                        </text>
                      </box>
                      <text fg={input.theme.textMuted}>
                        {draft()?.editingCustom
                          ? `> ${draft()?.customAnswers[draft()?.activeTabIndex ?? 0] ?? ""}_`
                          : draft()?.customAnswers[draft()?.activeTabIndex ?? 0] ||
                            "Type your own answer"}
                      </text>
                    </box>
                  </Show>
                </box>
              </Show>
            </box>
          }
          actions={
            confirmTab()
              ? [
                  {
                    label: "Submit",
                    active: true,
                    onSelect: () => {
                      void input.runtime.handleInput({
                        key: "enter",
                        ctrl: false,
                        meta: false,
                        shift: false,
                      });
                    },
                  },
                ]
              : draft()?.editingCustom
                ? [
                    {
                      label: "Save custom",
                      active: true,
                      onSelect: () => {
                        void input.runtime.handleInput({
                          key: "enter",
                          ctrl: false,
                          meta: false,
                          shift: false,
                        });
                      },
                    },
                  ]
                : []
          }
          hints={[
            total() > 1 ? "pgup/pgdn request" : "",
            questionTabCount(currentRequest()) > 1 ? "tab switch" : "",
            !confirmTab() ? "↑↓ choose" : "",
            !confirmTab() && optionCount() > 0 ? "1-9 pick" : "",
            !confirmTab() ? "enter select" : "enter submit",
            "esc dismiss",
          ].filter(Boolean)}
        />
      )}
    </Show>
  );
}
