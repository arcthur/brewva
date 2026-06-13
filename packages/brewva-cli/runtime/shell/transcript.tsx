/** @jsxImportSource @opentui/solid */

import type { BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import type { JSX } from "solid-js";
import { For, Index, Match, Show, Switch, createEffect, createMemo, createSignal } from "solid-js";
import {
  formatOperatorSafetyShellTitle,
  type OperatorSafetyShellTone,
} from "../../src/shell/domain/operator-safety/shell-view.js";
import type {
  CliShellTranscriptMessage,
  CliShellTranscriptPart,
  CliShellTranscriptToolPart,
} from "../../src/shell/domain/transcript.js";
import { useRenderer } from "../opentui/index.js";
import { DiffView, formatDiffFileTitle } from "./diff-view.js";
import { MarkdownTranscriptBlock } from "./markdown-transcript-block.js";
import { MermaidBlock } from "./mermaid/mermaid-block.js";
import {
  SPLIT_BORDER_CHARS,
  getReasoningSyntaxStyle,
  getTranscriptSyntaxStyle,
  type SessionPalette,
} from "./palette.js";
import { useShellRenderContext } from "./render-context.js";
import { streamingTailWindow } from "./streaming-tail.js";
import {
  asRecord,
  inferFiletype,
  readToolDisplayDetailsText,
  readToolDisplaySummaryText,
  readToolDisplayText,
  readToolDiffPayload,
  readToolErrorText,
  readToolPath,
  readToolRangeSuffix,
  readToolResultText,
  readToolTextInput,
  readToolCommand,
  readToolWorkerSessionId,
  renderToolComponentLines,
  summarizeInput,
  type ToolRenderCache,
} from "./tool-render.js";
import { classifyTranscriptTextBlock } from "./transcript-markdown.js";

export type TranscriptRenderSurface = "interactive" | "scrollback";

export function TextLineBlock(input: {
  lines: readonly string[];
  color: string;
  paddingLeft?: number;
}) {
  return (
    <box flexDirection="column" gap={0} flexShrink={0}>
      <For each={input.lines}>
        {(line) => (
          <text paddingLeft={input.paddingLeft ?? 1} fg={input.color} flexShrink={0}>
            {line}
          </text>
        )}
      </For>
    </box>
  );
}

function safetyToneColor(theme: SessionPalette, tone: OperatorSafetyShellTone): string {
  switch (tone) {
    case "error":
      return theme.error;
    case "warning":
      return theme.warning;
    case "success":
      return theme.success;
    case "info":
      return theme.accent;
    case "neutral":
      return theme.textMuted;
    default:
      throw new Error(`Unsupported operator safety tone: ${String(tone)}`);
  }
}

function StreamingTextPreview(input: { content: string; theme: SessionPalette }) {
  // Bound the in-flight block so per-frame measure/wrap cost stays constant
  // regardless of response length; the full text renders as markdown once
  // the message stabilizes (RFC F8/WS6). The raw content goes in untrimmed —
  // streamingTailWindow trims within the window so the per-flush cost stays
  // O(window) instead of O(content).
  const tail = createMemo(() => streamingTailWindow(input.content));
  return (
    <Show when={tail().text.length > 0}>
      <Show when={tail().truncated}>
        <text fg={input.theme.textMuted}>… streaming, earlier lines render on completion</text>
      </Show>
      <text fg={input.theme.markdownText}>{tail().text}</text>
    </Show>
  );
}

function TranscriptTextBlockView(input: {
  content: string;
  theme: SessionPalette;
  streamingPreview: boolean;
  renderSurface: TranscriptRenderSurface;
  markdownStreaming: boolean;
}) {
  const classification = createMemo(() => classifyTranscriptTextBlock({ content: input.content }));
  const mermaidSource = createMemo(() => {
    if (input.streamingPreview || input.renderSurface === "interactive") {
      return undefined;
    }
    const current = classification();
    return current.kind === "mermaid" ? current.source : undefined;
  });
  return (
    <Switch>
      <Match when={input.streamingPreview}>
        <StreamingTextPreview content={input.content} theme={input.theme} />
      </Match>
      <Match when={mermaidSource()}>
        {(source) => <MermaidBlock source={source()} theme={input.theme} />}
      </Match>
      <Match when={input.renderSurface === "interactive"}>
        <MarkdownTranscriptBlock content={input.content} theme={input.theme} streaming={false} />
      </Match>
      <Match when={true}>
        <MarkdownTranscriptBlock
          content={input.content}
          theme={input.theme}
          streaming={input.markdownStreaming}
        />
      </Match>
    </Switch>
  );
}

function createPersistentStreamingCodePath(isStreaming: () => boolean): () => boolean {
  const [hasStreamed, setHasStreamed] = createSignal(isStreaming());
  createEffect(() => {
    if (isStreaming()) {
      setHasStreamed(true);
    }
  });
  return () => hasStreamed() || isStreaming();
}

function InlineTool(input: {
  icon: string;
  pending: string;
  complete: boolean;
  text: string;
  part: CliShellTranscriptToolPart;
  theme: SessionPalette;
  errorText?: string;
  hint?: string;
  onSelect?: () => void;
}) {
  const renderer = useRenderer();
  const [hovered, setHovered] = createSignal(false);
  const actionable = createMemo(() => Boolean(input.onSelect));
  const handleSelect = () => {
    if (renderer.getSelection()?.getSelectedText()) {
      return;
    }
    input.onSelect?.();
  };
  const tone = createMemo(() => {
    if (input.part.status === "error") {
      return input.theme.error;
    }
    if (hovered() && actionable()) {
      return input.theme.accent;
    }
    return safetyToneColor(input.theme, input.part.safety.tone);
  });
  return (
    <box
      id={`tool-${input.part.id}`}
      marginTop={1}
      paddingLeft={3}
      paddingRight={2}
      flexDirection="column"
      backgroundColor={hovered() ? input.theme.backgroundElement : undefined}
      onMouseMove={() => setHovered(true)}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseUp={handleSelect}
    >
      <text paddingLeft={3} fg={tone()}>
        <Show when={input.complete} fallback={`~ ${input.pending}`}>
          <span
            style={{
              fg: input.part.status === "error" ? input.theme.error : input.theme.textMuted,
            }}
          >
            {input.icon}
          </span>{" "}
          {input.text}
        </Show>
      </text>
      <Show when={hovered() && input.hint}>
        {(hint) => (
          <text paddingLeft={3} fg={input.theme.textMuted}>
            {hint()}
          </text>
        )}
      </Show>
      <Show when={input.errorText}>
        <text fg={input.theme.error}>{input.errorText}</text>
      </Show>
    </box>
  );
}

function BlockTool(input: {
  title: string;
  part: CliShellTranscriptToolPart;
  theme: SessionPalette;
  titleColor?: string;
  children: JSX.Element;
  idSuffix?: string;
  hint?: string;
  onSelect?: () => void;
}) {
  const renderer = useRenderer();
  const [hovered, setHovered] = createSignal(false);
  const actionable = createMemo(() => Boolean(input.onSelect));
  const handleSelect = () => {
    if (renderer.getSelection()?.getSelectedText()) {
      return;
    }
    input.onSelect?.();
  };
  return (
    <box
      id={`tool-${input.part.id}${input.idSuffix ? `:${input.idSuffix}` : ""}`}
      border={["left"]}
      customBorderChars={SPLIT_BORDER_CHARS}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      marginTop={1}
      gap={1}
      backgroundColor={hovered() ? input.theme.backgroundElement : input.theme.backgroundPanel}
      borderColor={
        hovered() && actionable()
          ? (input.titleColor ?? input.theme.borderActive)
          : input.theme.background
      }
      flexDirection="column"
      onMouseMove={() => setHovered(true)}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseUp={handleSelect}
    >
      <box flexDirection="row" justifyContent="space-between" paddingRight={3}>
        <text fg={input.titleColor ?? safetyToneColor(input.theme, input.part.safety.tone)}>
          {input.title}
        </text>
        <Show when={hovered() && input.hint}>
          {(hint) => (
            <text fg={hovered() ? input.theme.accent : input.theme.textMuted}>{hint()}</text>
          )}
        </Show>
      </box>
      {input.children}
      <Show when={readToolErrorText(input.part)}>
        <text paddingLeft={1} fg={input.theme.error}>
          {readToolErrorText(input.part)}
        </text>
      </Show>
    </box>
  );
}

function TextPartView(input: {
  part: Extract<CliShellTranscriptPart, { type: "text" }>;
  theme: SessionPalette;
  renderSurface: TranscriptRenderSurface;
}) {
  const content = createMemo(() => input.part.text.trim());
  const streamingPreview = createMemo(
    () => input.renderSurface === "interactive" && input.part.renderMode === "streaming",
  );
  return (
    <Show when={content().length > 0}>
      <box id={`text-${input.part.id}`} paddingLeft={3} marginTop={1} flexShrink={0}>
        <TranscriptTextBlockView
          content={content()}
          theme={input.theme}
          streamingPreview={streamingPreview()}
          renderSurface={input.renderSurface}
          markdownStreaming={input.part.renderMode === "streaming"}
        />
      </box>
    </Show>
  );
}

function ReasoningPartView(input: {
  part: Extract<CliShellTranscriptPart, { type: "reasoning" }>;
  theme: SessionPalette;
  renderSurface: TranscriptRenderSurface;
}) {
  const shellContext = useShellRenderContext();
  const content = createMemo(() => input.part.text.replace("[REDACTED]", "").trim());
  const streaming = createMemo(() => input.part.renderMode === "streaming");
  const useStreamingCodePath = createPersistentStreamingCodePath(streaming);
  const streamingPreview = createMemo(() => input.renderSurface === "interactive" && streaming());
  const codeStreaming = createMemo(() => !streamingPreview() && useStreamingCodePath());
  const previewText = createMemo(() => {
    const firstLine = content()
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return firstLine ? `Thinking: ${firstLine}` : "Thinking";
  });
  return (
    <Show when={shellContext.showThinking() && content().length > 0}>
      <box
        id={`text-${input.part.id}`}
        paddingLeft={2}
        marginTop={1}
        flexDirection="column"
        border={["left"]}
        borderColor={input.theme.backgroundElement}
      >
        <Switch>
          <Match when={streamingPreview()}>
            <text fg={input.theme.textMuted} wrapMode="none">
              {previewText()}
            </text>
          </Match>
          <Match when={true}>
            <code
              filetype="markdown"
              drawUnstyledText={!codeStreaming()}
              streaming={codeStreaming()}
              syntaxStyle={getReasoningSyntaxStyle(input.theme)}
              content={`_Thinking:_ ${content()}`}
              fg={input.theme.textMuted}
            />
          </Match>
        </Switch>
      </box>
    </Show>
  );
}

function ReadToolView(input: { part: CliShellTranscriptToolPart; theme: SessionPalette }) {
  const path = createMemo(() => readToolPath(input.part) ?? "file");
  const summary = createMemo(() =>
    summarizeInput(input.part.args, [
      "path",
      "filePath",
      "file_path",
      "offset",
      "startLine",
      "line",
      "limit",
      "lineCount",
      "count",
    ]),
  );
  const text = createMemo(
    () =>
      `Read ${path()}${readToolRangeSuffix(input.part)}${summary().length > 0 ? ` ${summary()}` : ""}`,
  );
  return (
    <InlineTool
      icon="→"
      pending={input.part.safety.statusText}
      complete={input.part.status !== "pending"}
      text={formatOperatorSafetyShellTitle(input.part.safety, text())}
      part={input.part}
      theme={input.theme}
      errorText={readToolErrorText(input.part)}
    />
  );
}

function WriteToolView(input: { part: CliShellTranscriptToolPart; theme: SessionPalette }) {
  const path = createMemo(() => readToolPath(input.part) ?? "file");
  const content = createMemo(() => readToolTextInput(input.part) ?? "");
  return (
    <Switch>
      <Match when={content().length > 0 && input.part.status === "completed"}>
        <BlockTool
          title={formatOperatorSafetyShellTitle(input.part.safety, `Wrote ${path()}`)}
          part={input.part}
          theme={input.theme}
        >
          <box paddingLeft={1}>
            <code
              fg={input.theme.text}
              filetype={inferFiletype(path())}
              syntaxStyle={getTranscriptSyntaxStyle(input.theme)}
              content={content()}
            />
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="←"
          pending={input.part.safety.statusText}
          complete={Boolean(readToolPath(input.part))}
          text={formatOperatorSafetyShellTitle(input.part.safety, `Write ${path()}`)}
          part={input.part}
          theme={input.theme}
          errorText={readToolErrorText(input.part)}
        />
      </Match>
    </Switch>
  );
}

function formatDiffToolTitle(part: CliShellTranscriptToolPart, path: string): string {
  if (part.toolName === "edit") {
    return formatOperatorSafetyShellTitle(part.safety, `Edit ${path}`);
  }
  if (part.toolName === "apply_patch") {
    return formatOperatorSafetyShellTitle(part.safety, `Patch ${path}`);
  }
  return formatOperatorSafetyShellTitle(part.safety, `${part.toolName} ${path}`.trim());
}

function DiffToolView(input: {
  part: CliShellTranscriptToolPart;
  theme: SessionPalette;
  transcriptWidth: number;
}) {
  const shellContext = useShellRenderContext();
  const path = createMemo(() => readToolPath(input.part) ?? "file");
  const payload = createMemo(() => readToolDiffPayload(input.part));
  const singleDiff = createMemo(() => {
    const current = payload();
    return current?.kind === "single" ? current : undefined;
  });
  const diffFiles = createMemo(() => {
    const current = payload();
    return current?.kind === "files" ? current.files : [];
  });
  return (
    <Switch>
      <Match when={singleDiff()}>
        <BlockTool
          title={formatDiffToolTitle(input.part, path())}
          part={input.part}
          theme={input.theme}
        >
          <DiffView
            diff={singleDiff()?.diff ?? ""}
            filePath={singleDiff()?.path ?? path()}
            width={input.transcriptWidth}
            style={shellContext.diffStyle()}
            wrapMode={shellContext.diffWrapMode()}
            theme={input.theme}
          />
        </BlockTool>
      </Match>
      <Match when={diffFiles().length > 0}>
        <box flexDirection="column" gap={0}>
          <For each={diffFiles()}>
            {(file, index) => (
              <BlockTool
                title={formatOperatorSafetyShellTitle(input.part.safety, formatDiffFileTitle(file))}
                part={input.part}
                theme={input.theme}
                idSuffix={`file:${index()}`}
              >
                <Show
                  when={file.diff.length > 0}
                  fallback={
                    <text paddingLeft={1} fg={input.theme.diffRemoved}>
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
              </BlockTool>
            )}
          </For>
        </box>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="←"
          pending={input.part.safety.statusText}
          complete={Boolean(readToolPath(input.part))}
          text={formatOperatorSafetyShellTitle(
            input.part.safety,
            `${input.part.toolName === "apply_patch" ? "Patch" : "Edit"} ${path()} ${summarizeInput(input.part.args, ["path", "filePath", "file_path"])}`.trim(),
          )}
          part={input.part}
          theme={input.theme}
          errorText={readToolErrorText(input.part)}
        />
      </Match>
    </Switch>
  );
}

const EXEC_COLLAPSED_LINE_LIMIT = 10;
const GENERIC_COLLAPSED_LINE_LIMIT = 5;

function formatCollapseHint(input: {
  expanded: boolean;
  hiddenLineCount: number;
  totalLineCount: number;
}): string {
  if (input.expanded) {
    return "Click to collapse";
  }
  if (input.hiddenLineCount > 0) {
    return `Click to expand ${input.hiddenLineCount} more line(s) · ${input.totalLineCount} lines total`;
  }
  return "Click to expand";
}

function formatGenericDiffTitle(path: string | undefined): string {
  return path ? `Diff ${path}` : "Diff";
}

function isDiffLikeText(text: string): boolean {
  return /^(diff --git|--- |\+\+\+ |@@ )/mu.test(text);
}

function isExecToolName(toolName: string): boolean {
  return toolName === "exec";
}

function firstNonEmptyLine(text: string): string | undefined {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

interface TranscriptToolInteractionState {
  execExpanded?: boolean;
  genericExpanded?: boolean;
}

function readTranscriptToolInteractionState(
  cache: ToolRenderCache,
  toolCallId: string,
): TranscriptToolInteractionState {
  const existing = asRecord(cache.stateByToolCallId.get(toolCallId));
  if (existing) {
    return existing as TranscriptToolInteractionState;
  }
  const created: TranscriptToolInteractionState = {};
  cache.stateByToolCallId.set(toolCallId, created);
  return created;
}

function ExecToolView(input: {
  part: CliShellTranscriptToolPart;
  theme: SessionPalette;
  toolRenderCache: ToolRenderCache;
}) {
  const interactionState = readTranscriptToolInteractionState(
    input.toolRenderCache,
    input.part.toolCallId,
  );
  const [expanded, setExpanded] = createSignal(Boolean(interactionState.execExpanded));
  const command = createMemo(() => readToolCommand(input.part) ?? "");
  const outputText = createMemo(
    () => readToolDisplayDetailsText(input.part) ?? readToolResultText(input.part),
  );
  const summaryText = createMemo(() => readToolDisplaySummaryText(input.part));
  const outputLines = createMemo(() => {
    const output = outputText();
    return output.length > 0 ? output.split(/\r?\n/u) : [];
  });
  const summaryLines = createMemo(() => {
    const summary = summaryText();
    return summary && summary.trim() !== outputText().trim() ? summary.split(/\r?\n/u) : [];
  });
  const collapsedOutputLines = createMemo(() => {
    if (summaryLines().length > 0) {
      return summaryLines().slice(0, EXEC_COLLAPSED_LINE_LIMIT);
    }
    return outputLines().slice(0, EXEC_COLLAPSED_LINE_LIMIT);
  });
  const collapsible = createMemo(
    () => outputLines().length > EXEC_COLLAPSED_LINE_LIMIT || summaryLines().length > 0,
  );
  const visibleOutputLines = createMemo(() =>
    collapsible() && !expanded() ? collapsedOutputLines() : outputLines(),
  );
  const hiddenLineCount = createMemo(() =>
    Math.max(0, outputLines().length - visibleOutputLines().length),
  );
  const toggleExpanded = () => {
    if (!collapsible()) {
      return;
    }
    const next = !expanded();
    interactionState.execExpanded = next;
    setExpanded(next);
  };
  const collapseHint = createMemo(() =>
    formatCollapseHint({
      expanded: expanded(),
      hiddenLineCount: hiddenLineCount(),
      totalLineCount: outputLines().length,
    }),
  );
  const title = createMemo(() => {
    const args: Record<string, unknown> = (input.part.args as Record<string, unknown>) ?? {};
    const description = (typeof args.description === "string" ? args.description : null) ?? "Shell";
    const workdir =
      typeof args.workdir === "string" || typeof args.cwd === "string"
        ? ((args.workdir as string | undefined) ?? (args.cwd as string | undefined))
        : undefined;
    if (!workdir || description.includes(workdir)) {
      return formatOperatorSafetyShellTitle(input.part.safety, description);
    }
    return formatOperatorSafetyShellTitle(input.part.safety, `${description} in ${workdir}`);
  });
  return (
    <Switch>
      <Match
        when={
          command().length > 0 && (outputLines().length > 0 || input.part.status === "completed")
        }
      >
        <BlockTool
          title={title()}
          part={input.part}
          theme={input.theme}
          onSelect={collapsible() ? toggleExpanded : undefined}
        >
          <box flexDirection="column" gap={0}>
            <text paddingLeft={1} fg={input.theme.text}>
              $ {command()}
            </text>
            <Show when={visibleOutputLines().length > 0}>
              <TextLineBlock lines={visibleOutputLines()} color={input.theme.text} />
            </Show>
            <Show when={collapsible()}>
              <text paddingLeft={1} fg={input.theme.textMuted}>
                {collapseHint()}
              </text>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="$"
          pending={input.part.safety.statusText}
          complete={command().length > 0}
          text={formatOperatorSafetyShellTitle(input.part.safety, command())}
          part={input.part}
          theme={input.theme}
          errorText={readToolErrorText(input.part)}
        />
      </Match>
    </Switch>
  );
}

function GenericToolView(input: {
  part: CliShellTranscriptToolPart;
  theme: SessionPalette;
  toolDefinitions: ReadonlyMap<string, BrewvaToolDefinition>;
  toolRenderCache: ToolRenderCache;
  transcriptWidth: number;
  showDetails: boolean;
}) {
  const shellContext = useShellRenderContext();
  const interactionState = readTranscriptToolInteractionState(
    input.toolRenderCache,
    input.part.toolCallId,
  );
  const [expanded, setExpanded] = createSignal(Boolean(interactionState.genericExpanded));
  const workerSessionId = createMemo(() =>
    input.part.toolName === "subagent_run" || input.part.toolName === "subagent_fanout"
      ? readToolWorkerSessionId(input.part)
      : undefined,
  );
  const openWorkerSession = () => {
    const sessionId = workerSessionId();
    if (!sessionId) {
      return;
    }
    void shellContext.runtime.handleInput({ type: "session.open", sessionId });
  };
  const workerSessionHint = createMemo(() =>
    workerSessionId() ? "Click to open worker session" : undefined,
  );
  const diffPayload = createMemo(() => readToolDiffPayload(input.part));
  const singleDiff = createMemo(() => {
    const current = diffPayload();
    return current?.kind === "single" ? current : undefined;
  });
  const diffFiles = createMemo(() => {
    const current = diffPayload();
    return current?.kind === "files" ? current.files : [];
  });
  const hasDiffPayload = createMemo(() => Boolean(singleDiff()) || diffFiles().length > 0);
  const displaySummaryText = createMemo(() => readToolDisplaySummaryText(input.part));
  const inlineText = createMemo(() => {
    const summary = displaySummaryText();
    if (summary) {
      return formatOperatorSafetyShellTitle(
        input.part.safety,
        firstNonEmptyLine(summary) ?? input.part.toolName,
      );
    }
    return formatOperatorSafetyShellTitle(
      input.part.safety,
      `${input.part.toolName} ${summarizeInput(input.part.args)}`.trim(),
    );
  });
  const callLines = createMemo(() =>
    renderToolComponentLines({
      kind: "call",
      toolDefinitions: input.toolDefinitions,
      toolRenderCache: input.toolRenderCache,
      part: input.part,
      width: input.transcriptWidth,
      expanded: true,
    }),
  );
  const resultLines = createMemo(() =>
    renderToolComponentLines({
      kind: "result",
      toolDefinitions: input.toolDefinitions,
      toolRenderCache: input.toolRenderCache,
      part: input.part,
      width: input.transcriptWidth,
      expanded: expanded(),
    }),
  );
  const fallbackCallLines = createMemo(() => {
    if (callLines().length > 0) {
      return callLines();
    }
    const summary = summarizeInput(input.part.args);
    return summary.length > 0 ? [summary] : [];
  });
  const defaultCollapsedResultText = createMemo(() => readToolDisplayText(input.part, false));
  const defaultExpandedResultText = createMemo(() => readToolDisplayText(input.part, true));
  const diffSummaryText = createMemo(() => {
    const summary = displaySummaryText();
    if (summary) {
      return summary;
    }
    const rawText = readToolResultText(input.part);
    return rawText.trim().length > 0 && !isDiffLikeText(rawText) ? rawText : "";
  });
  const resultText = createMemo(() => {
    if (resultLines().length > 0) {
      return resultLines().join("\n");
    }
    if (hasDiffPayload()) {
      return diffSummaryText();
    }
    return expanded() ? defaultExpandedResultText() : defaultCollapsedResultText();
  });
  const usesCollapsedDisplaySummary = createMemo(
    () =>
      !expanded() &&
      !hasDiffPayload() &&
      resultLines().length === 0 &&
      Boolean(displaySummaryText()),
  );
  const resultTextLines = createMemo(() => {
    const text = resultText().trimEnd();
    return text.length > 0 ? text.split(/\r?\n/u) : [];
  });
  const resultCollapsible = createMemo(() => {
    if (hasDiffPayload()) {
      return false;
    }
    if (resultLines().length > 0 && input.part.status !== "pending") {
      return true;
    }
    if (displaySummaryText()) {
      return true;
    }
    const collapsedText = defaultCollapsedResultText().trim();
    const expandedText = defaultExpandedResultText().trim();
    if (collapsedText.length > 0 && expandedText.length > 0 && collapsedText !== expandedText) {
      return true;
    }
    return resultTextLines().length > GENERIC_COLLAPSED_LINE_LIMIT;
  });
  const visibleResultLines = createMemo(() =>
    resultCollapsible() && !expanded()
      ? resultTextLines().slice(0, GENERIC_COLLAPSED_LINE_LIMIT)
      : resultTextLines(),
  );
  const expandedResultLineCount = createMemo(() => {
    const text = defaultExpandedResultText().trimEnd();
    return text.length > 0 ? text.split(/\r?\n/u).length : resultTextLines().length;
  });
  const totalResultLineCount = createMemo(() =>
    Math.max(expandedResultLineCount(), resultTextLines().length),
  );
  const hiddenLineCount = createMemo(() =>
    Math.max(0, totalResultLineCount() - visibleResultLines().length),
  );
  const collapseHint = createMemo(() => {
    if (usesCollapsedDisplaySummary()) {
      return formatCollapseHint({
        expanded: false,
        hiddenLineCount: 0,
        totalLineCount: visibleResultLines().length,
      });
    }
    return formatCollapseHint({
      expanded: expanded(),
      hiddenLineCount: hiddenLineCount(),
      totalLineCount: totalResultLineCount(),
    });
  });
  const toggleExpanded = () => {
    if (!resultCollapsible()) {
      return;
    }
    const next = !expanded();
    interactionState.genericExpanded = next;
    setExpanded(next);
  };
  const selectTool = () => {
    if (resultCollapsible()) {
      toggleExpanded();
      return;
    }
    openWorkerSession();
  };
  const selectHint = createMemo(() => {
    if (resultCollapsible()) {
      return undefined;
    }
    return workerSessionHint();
  });

  return (
    <Switch>
      <Match when={!input.showDetails && input.part.status === "completed"}>
        <InlineTool
          icon="⚙"
          pending={input.part.safety.statusText}
          complete={true}
          text={inlineText()}
          part={input.part}
          theme={input.theme}
          errorText={readToolErrorText(input.part)}
          hint={workerSessionHint()}
          onSelect={workerSessionId() ? openWorkerSession : undefined}
        />
      </Match>
      <Match
        when={resultText().trim().length > 0 || fallbackCallLines().length > 0 || hasDiffPayload()}
      >
        <BlockTool
          title={input.part.safety.title}
          part={input.part}
          theme={input.theme}
          hint={selectHint()}
          onSelect={resultCollapsible() || workerSessionId() ? selectTool : undefined}
        >
          <box flexDirection="column" gap={1}>
            <TextLineBlock lines={fallbackCallLines()} color={input.theme.text} />
            <Show when={visibleResultLines().length > 0}>
              <TextLineBlock
                lines={visibleResultLines()}
                color={input.part.status === "error" ? input.theme.error : input.theme.text}
              />
            </Show>
            <Show when={singleDiff()}>
              <box flexDirection="column" gap={0}>
                <text paddingLeft={1} fg={input.theme.textMuted}>
                  {formatGenericDiffTitle(singleDiff()?.path ?? readToolPath(input.part))}
                </text>
                <DiffView
                  diff={singleDiff()?.diff ?? ""}
                  filePath={singleDiff()?.path ?? readToolPath(input.part)}
                  width={input.transcriptWidth}
                  style={shellContext.diffStyle()}
                  wrapMode={shellContext.diffWrapMode()}
                  theme={input.theme}
                />
              </box>
            </Show>
            <Show when={diffFiles().length > 0}>
              <box flexDirection="column" gap={1}>
                <For each={diffFiles()}>
                  {(file) => (
                    <box flexDirection="column" gap={0}>
                      <text paddingLeft={1} fg={input.theme.textMuted}>
                        {formatDiffFileTitle(file)}
                      </text>
                      <Show
                        when={file.diff.length > 0}
                        fallback={
                          <text paddingLeft={1} fg={input.theme.diffRemoved}>
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
            <Show when={resultCollapsible()}>
              <text paddingLeft={1} fg={input.theme.textMuted}>
                {collapseHint()}
              </text>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="⚙"
          pending={input.part.safety.statusText}
          complete={input.part.status === "completed"}
          text={inlineText()}
          part={input.part}
          theme={input.theme}
          errorText={readToolErrorText(input.part)}
          hint={workerSessionHint()}
          onSelect={workerSessionId() ? openWorkerSession : undefined}
        />
      </Match>
    </Switch>
  );
}

function isTerminalToolStatus(status: CliShellTranscriptToolPart["status"]): boolean {
  return status === "completed" || status === "error";
}

function StreamingToolPreview(input: { part: CliShellTranscriptToolPart; theme: SessionPalette }) {
  const text = createMemo(() =>
    formatOperatorSafetyShellTitle(
      input.part.safety,
      `${input.part.toolName} ${summarizeInput(input.part.args)}`.trim(),
    ),
  );
  return (
    <InlineTool
      icon="·"
      pending={input.part.safety.statusText}
      complete={true}
      text={text()}
      part={input.part}
      theme={input.theme}
      errorText={readToolErrorText(input.part)}
    />
  );
}

function ToolPartView(input: {
  part: CliShellTranscriptToolPart;
  theme: SessionPalette;
  toolDefinitions: ReadonlyMap<string, BrewvaToolDefinition>;
  toolRenderCache: ToolRenderCache;
  transcriptWidth: number;
  showDetails: boolean;
  renderSurface: TranscriptRenderSurface;
}) {
  const streamingPreview = createMemo(
    () =>
      input.renderSurface === "interactive" &&
      input.part.renderMode === "streaming" &&
      !isTerminalToolStatus(input.part.status),
  );
  return (
    <Switch>
      <Match when={streamingPreview()}>
        <StreamingToolPreview part={input.part} theme={input.theme} />
      </Match>
      <Match when={input.part.toolName === "read"}>
        <ReadToolView part={input.part} theme={input.theme} />
      </Match>
      <Match when={input.part.toolName === "write"}>
        <WriteToolView part={input.part} theme={input.theme} />
      </Match>
      <Match when={input.part.toolName === "edit" || input.part.toolName === "apply_patch"}>
        <DiffToolView
          part={input.part}
          theme={input.theme}
          transcriptWidth={input.transcriptWidth}
        />
      </Match>
      <Match when={isExecToolName(input.part.toolName)}>
        <ExecToolView
          part={input.part}
          theme={input.theme}
          toolRenderCache={input.toolRenderCache}
        />
      </Match>
      <Match when={true}>
        <GenericToolView
          part={input.part}
          theme={input.theme}
          toolDefinitions={input.toolDefinitions}
          toolRenderCache={input.toolRenderCache}
          transcriptWidth={input.transcriptWidth}
          showDetails={input.showDetails}
        />
      </Match>
    </Switch>
  );
}

function AssistantMessageView(input: {
  message: CliShellTranscriptMessage;
  theme: SessionPalette;
  toolDefinitions: ReadonlyMap<string, BrewvaToolDefinition>;
  toolRenderCache: ToolRenderCache;
  transcriptWidth: number;
  showToolDetails: boolean;
  isLast: boolean;
  assistantLabel: string;
  modelLabel: string;
  renderSurface: TranscriptRenderSurface;
}) {
  return (
    <>
      <Index each={input.message.parts}>
        {(part) => {
          const current = part();
          if (current.type === "text") {
            return (
              <TextPartView
                part={current}
                theme={input.theme}
                renderSurface={input.renderSurface}
              />
            );
          }
          if (current.type === "reasoning") {
            return (
              <ReasoningPartView
                part={current}
                theme={input.theme}
                renderSurface={input.renderSurface}
              />
            );
          }
          if (current.type === "tool") {
            return (
              <ToolPartView
                part={current}
                theme={input.theme}
                toolDefinitions={input.toolDefinitions}
                toolRenderCache={input.toolRenderCache}
                transcriptWidth={input.transcriptWidth}
                showDetails={input.showToolDetails}
                renderSurface={input.renderSurface}
              />
            );
          }
          return null;
        }}
      </Index>
      <Show when={input.isLast || input.message.renderMode !== "streaming"}>
        <box paddingLeft={3}>
          <text marginTop={1}>
            <span style={{ fg: input.theme.accent }}>▣ </span>
            <span style={{ fg: input.theme.text }}>{input.assistantLabel}</span>
            <span style={{ fg: input.theme.textMuted }}> · {input.modelLabel}</span>
          </text>
        </box>
      </Show>
    </>
  );
}

function ToolMessageView(input: {
  message: CliShellTranscriptMessage;
  theme: SessionPalette;
  toolDefinitions: ReadonlyMap<string, BrewvaToolDefinition>;
  toolRenderCache: ToolRenderCache;
  transcriptWidth: number;
  showToolDetails: boolean;
  renderSurface: TranscriptRenderSurface;
}) {
  return (
    <Index each={input.message.parts}>
      {(part) => {
        const current = part();
        if (current.type === "text") {
          return (
            <TextPartView part={current} theme={input.theme} renderSurface={input.renderSurface} />
          );
        }
        if (current.type === "reasoning") {
          return (
            <ReasoningPartView
              part={current}
              theme={input.theme}
              renderSurface={input.renderSurface}
            />
          );
        }
        if (current.type === "tool") {
          return (
            <ToolPartView
              part={current}
              theme={input.theme}
              toolDefinitions={input.toolDefinitions}
              toolRenderCache={input.toolRenderCache}
              transcriptWidth={input.transcriptWidth}
              showDetails={input.showToolDetails}
              renderSurface={input.renderSurface}
            />
          );
        }
        return null;
      }}
    </Index>
  );
}

function UserMessageView(input: {
  message: CliShellTranscriptMessage;
  theme: SessionPalette;
  index: number;
}) {
  const text = createMemo(() =>
    input.message.parts
      .filter(
        (part): part is Extract<CliShellTranscriptPart, { type: "text" }> => part.type === "text",
      )
      .map((part) => part.text)
      .join("\n")
      .trim(),
  );
  return (
    <Show when={text()}>
      <box
        id={input.message.id}
        border={["left"]}
        customBorderChars={SPLIT_BORDER_CHARS}
        borderColor={input.theme.accent}
        marginTop={input.index === 0 ? 0 : 1}
      >
        <box
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          backgroundColor={input.theme.backgroundPanel}
          flexShrink={0}
        >
          <text fg={input.theme.text}>{text()}</text>
        </box>
      </box>
    </Show>
  );
}

function NoteMessageView(input: {
  message: CliShellTranscriptMessage;
  theme: SessionPalette;
  label: string;
}) {
  const text = createMemo(() =>
    input.message.parts
      .filter(
        (part): part is Extract<CliShellTranscriptPart, { type: "text" }> => part.type === "text",
      )
      .map((part) => part.text)
      .join("\n")
      .trim(),
  );
  return (
    <Show when={text()}>
      <box
        id={input.message.id}
        border={["left"]}
        customBorderChars={SPLIT_BORDER_CHARS}
        borderColor={input.theme.borderSubtle}
        marginTop={1}
      >
        <box
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          backgroundColor={input.theme.backgroundPanel}
          flexShrink={0}
          flexDirection="column"
        >
          <text fg={input.theme.textMuted}>{input.label}</text>
          <text fg={input.theme.text}>{text()}</text>
        </box>
      </box>
    </Show>
  );
}

export function TranscriptMessageView(input: {
  message: CliShellTranscriptMessage;
  theme: SessionPalette;
  toolDefinitions: ReadonlyMap<string, BrewvaToolDefinition>;
  toolRenderCache: ToolRenderCache;
  transcriptWidth: number;
  showToolDetails: boolean;
  index: number;
  isLast: boolean;
  assistantLabel: string;
  modelLabel: string;
  renderSurface: TranscriptRenderSurface;
}) {
  if (input.message.role === "user") {
    return <UserMessageView message={input.message} theme={input.theme} index={input.index} />;
  }
  if (input.message.role === "assistant") {
    return (
      <AssistantMessageView
        message={input.message}
        theme={input.theme}
        toolDefinitions={input.toolDefinitions}
        toolRenderCache={input.toolRenderCache}
        transcriptWidth={input.transcriptWidth}
        showToolDetails={input.showToolDetails}
        isLast={input.isLast}
        assistantLabel={input.assistantLabel}
        modelLabel={input.modelLabel}
        renderSurface={input.renderSurface}
      />
    );
  }
  if (input.message.role === "system") {
    return <NoteMessageView message={input.message} theme={input.theme} label="System" />;
  }
  if (input.message.role === "tool") {
    return (
      <ToolMessageView
        message={input.message}
        theme={input.theme}
        toolDefinitions={input.toolDefinitions}
        toolRenderCache={input.toolRenderCache}
        transcriptWidth={input.transcriptWidth}
        showToolDetails={input.showToolDetails}
        renderSurface={input.renderSurface}
      />
    );
  }
  return <NoteMessageView message={input.message} theme={input.theme} label="Note" />;
}
