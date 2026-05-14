/** @jsxImportSource @opentui/solid */

import type { JSX } from "solid-js";
import { For, Show, createEffect, createMemo } from "solid-js";
import type {
  CliApprovalOverlayPayload,
  CliQuestionOverlayPayload,
} from "../../src/shell/domain/overlays/payloads.js";
import {
  countQuestionRequestKinds,
  isImmediateQuestionRequest,
  normalizeQuestionDraftState,
  resolveQuestionOverlayTitle,
  questionRequestsFromOverlay,
  questionTabCount,
} from "../../src/shell/domain/question-utils.js";
import type { ShellRendererController } from "../../src/shell/domain/renderer-contract.js";
import {
  buildTrustLoopApprovalEmptyProjection,
  buildTrustLoopApprovalProjection,
  type TrustLoopDetailKey,
} from "../../src/shell/domain/trust-loop/projection.js";
import type { OpenTuiScrollBoxHandle } from "../internal-opentui-runtime.js";
import { useTerminalDimensions } from "../opentui/index.js";
import { DiffView, formatDiffFileTitle } from "./diff-view.js";
import { DIALOG_Z_INDEX } from "./overlay-style.js";
import { DEFAULT_SCROLL_ACCELERATION, SPLIT_BORDER_CHARS, type SessionPalette } from "./palette.js";
import { useShellRenderContext } from "./render-context.js";
import {
  asRecord,
  readDiffPayloadFromDetails,
  readDiffSourceRecordFromDetails,
} from "./tool-render.js";

/** Rows reserved outside the question-option scroll viewport (title, hints, footer). */
const QUESTION_OPTION_SCROLL_RESERVED_TERMINAL_ROWS = 24;
/** Cap visible option rows so the overlay stays balanced on tall terminals. */
const QUESTION_OPTION_SCROLL_MAX_VISIBLE_ROWS = 13;
/** Floor visible rows so ↑/↓ navigation stays usable on short terminals. */
const QUESTION_OPTION_SCROLL_MIN_VISIBLE_ROWS = 4;

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

function leadingScrollRowsForQuestionOptions(
  options: readonly { description?: string }[],
  selectedIndex: number,
): number {
  const n = Math.max(0, Math.min(selectedIndex, options.length));
  let row = 0;
  for (let i = 0; i < n; i++) {
    row += options[i]?.description ? 2 : 1;
  }
  return row;
}

function focusedOptionChunkRows(
  options: readonly { description?: string }[],
  selectedIndex: number,
  hasCustomRow: boolean,
  editingCustom: boolean,
): number {
  if (selectedIndex < options.length) {
    return options[selectedIndex]?.description ? 2 : 1;
  }
  if (!hasCustomRow) {
    return 1;
  }
  return editingCustom ? 3 : 2;
}

function questionChoiceMarker(multiple: boolean | undefined, selected: boolean): string {
  if (multiple) {
    return selected ? "[x]" : "[ ]";
  }
  return selected ? "(*)" : "( )";
}

function customAnswerPicked(
  multiple: boolean | undefined,
  answers: readonly string[] | undefined,
  customAnswer: string,
): boolean {
  if (multiple) {
    return (answers ?? []).includes(customAnswer);
  }
  return (answers?.[0] ?? "") === customAnswer;
}

/** Single option row: primary line is one terminal row (scroll sync assumes fixed row height per option). */
function QuestionOptionRow(input: {
  theme: SessionPalette;
  numberLabel: string;
  choiceLabel: string;
  marker: string;
  focused: boolean;
  selected: boolean;
  description?: string;
}) {
  return (
    <box flexDirection="column" gap={0}>
      <box flexDirection="row" flexShrink={0}>
        <box
          flexShrink={0}
          paddingRight={1}
          backgroundColor={input.focused ? input.theme.backgroundElement : undefined}
        >
          <text fg={input.focused ? input.theme.secondary : input.theme.textMuted}>
            {input.numberLabel}
          </text>
        </box>
        <box
          flexShrink={1}
          flexGrow={1}
          backgroundColor={input.focused ? input.theme.backgroundElement : undefined}
        >
          <text
            fg={
              input.focused
                ? input.theme.secondary
                : input.selected
                  ? input.theme.success
                  : input.theme.text
            }
            wrapMode="none"
          >
            {`${input.marker} ${input.choiceLabel}`}
          </text>
        </box>
      </box>
      <Show when={input.description}>
        <box paddingLeft={3}>
          <text fg={input.theme.textMuted}>{input.description}</text>
        </box>
      </Show>
    </box>
  );
}

function InlinePromptCard(input: {
  title: string;
  theme: SessionPalette;
  accentColor: string;
  expanded?: boolean;
  /** No fixed outer height; grows with body (use bounded scroll regions inside body). */
  compact?: boolean;
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
      flexShrink={input.compact && !input.expanded ? 0 : undefined}
      zIndex={input.expanded ? DIALOG_Z_INDEX - 1 : undefined}
      {...(input.expanded
        ? {
            position: "absolute",
            top: 0,
            bottom: 1,
            left: 0,
            right: 0,
          }
        : input.compact
          ? { position: "relative" }
          : {
              position: "relative",
              minHeight: 20,
              maxHeight: 26,
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
  runtime: ShellRendererController;
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
  runtime: ShellRendererController;
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
  const total = createMemo(() => requests().length);
  const requestKindCounts = createMemo(() => countQuestionRequestKinds(requests()));
  let questionOptionsScrollbox: OpenTuiScrollBoxHandle | undefined;
  const dimensions = useTerminalDimensions();
  const questionOptionsViewportRows = createMemo(() =>
    Math.max(
      QUESTION_OPTION_SCROLL_MIN_VISIBLE_ROWS,
      Math.min(
        QUESTION_OPTION_SCROLL_MAX_VISIBLE_ROWS,
        dimensions().height - QUESTION_OPTION_SCROLL_RESERVED_TERMINAL_ROWS,
      ),
    ),
  );
  createEffect(() => {
    const node = questionOptionsScrollbox;
    if (!node || node.isDestroyed || confirmTab()) {
      return;
    }
    const q = question();
    const state = draft();
    if (!q || state === undefined) {
      return;
    }
    const options = q.options;
    const selected = state.selectedOptionIndex;
    const hasCustomRow = q.custom !== false;
    const top = leadingScrollRowsForQuestionOptions(options, selected);
    const chunk = focusedOptionChunkRows(options, selected, hasCustomRow, state.editingCustom);
    const viewportHeight = Math.max(1, node.viewport.height);
    const bottom = top + chunk - 1;
    const scrollBottom = node.scrollTop + viewportHeight;
    if (top < node.scrollTop) {
      node.scrollBy(top - node.scrollTop);
      return;
    }
    if (bottom >= scrollBottom) {
      node.scrollBy(bottom + 1 - scrollBottom);
    }
  });
  const questionCustomRow = createMemo(() => {
    const q = question();
    const state = draft();
    if (!q || q.custom === false || state === undefined) {
      return undefined;
    }
    const tabIx = state.activeTabIndex;
    const answersRow = state.answers[tabIx];
    const customAns = state.customAnswers[tabIx] ?? "";
    const multi = q.multiple;
    const picked = customAnswerPicked(multi, answersRow, customAns);
    return {
      numberLabel: `${q.options.length + 1}.`,
      marker: questionChoiceMarker(multi, picked),
      picked,
      previewText: state.editingCustom ? `> ${customAns}_` : customAns || "Type your own answer",
      focused: state.selectedOptionIndex === q.options.length,
    };
  });
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
          compact={Boolean(question())}
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
                  <scrollbox
                    ref={(node: OpenTuiScrollBoxHandle) => {
                      questionOptionsScrollbox = node;
                    }}
                    height={questionOptionsViewportRows()}
                    backgroundColor={input.theme.backgroundPanel}
                    scrollAcceleration={DEFAULT_SCROLL_ACCELERATION}
                    verticalScrollbarOptions={{
                      trackOptions: {
                        backgroundColor: input.theme.backgroundElement,
                        foregroundColor: input.theme.borderActive,
                      },
                    }}
                  >
                    <For each={question()?.options ?? []}>
                      {(option, index) => {
                        const selected = (
                          draft()?.answers[draft()?.activeTabIndex ?? 0] ?? []
                        ).includes(option.label);
                        const focused = draft()?.selectedOptionIndex === index();
                        const marker = questionChoiceMarker(question()?.multiple, selected);
                        return (
                          <QuestionOptionRow
                            theme={input.theme}
                            numberLabel={`${index() + 1}.`}
                            choiceLabel={option.label}
                            marker={marker}
                            focused={focused}
                            selected={selected}
                            description={option.description}
                          />
                        );
                      }}
                    </For>
                    <Show when={questionCustomRow()}>
                      {(row) => (
                        <box flexDirection="column" gap={0}>
                          <QuestionOptionRow
                            theme={input.theme}
                            numberLabel={row().numberLabel}
                            choiceLabel="Custom"
                            marker={row().marker}
                            focused={row().focused}
                            selected={row().picked}
                          />
                          <box paddingLeft={3}>
                            <text
                              fg={row().focused ? input.theme.secondary : input.theme.textMuted}
                            >
                              {row().previewText}
                            </text>
                          </box>
                        </box>
                      )}
                    </Show>
                  </scrollbox>
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
            !confirmTab() ? "↑↓ · ^n/^p choose" : "",
            !confirmTab() && optionCount() > 0 ? "1-9 pick" : "",
            !confirmTab() ? "enter select" : "enter submit",
            "esc dismiss",
          ].filter(Boolean)}
        />
      )}
    </Show>
  );
}
