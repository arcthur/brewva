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
import { capLineWidth, collapseCodeContent, splitFoldableCodeBlocks } from "./code-fold.js";
import { DiffView, formatDiffFileTitle } from "./diff-view.js";
import { MarkdownTranscriptBlock } from "./markdown-transcript-block.js";
import { MermaidBlock } from "./mermaid/mermaid-block.js";
import {
  SPLIT_BORDER_CHARS,
  getReasoningSyntaxStyle,
  getTranscriptSyntaxStyle,
  type SessionPalette,
} from "./palette.js";
import { summarizeReasoning } from "./reasoning-summary.js";
import { useShellRenderContext } from "./render-context.js";
import { createSyntaxStyleMemo } from "./syntax-style.js";
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
import { resolveInlineToolTone } from "./tool-tone.js";
import { classifyTranscriptTextBlock } from "./transcript-markdown.js";
import { useTranscriptRowSpacing } from "./transcript-row-spacing.js";

/**
 * The `▣ <assistantLabel> · <modelLabel>` header rendered beneath an assistant
 * message (AssistantMessageView). The caller owns the surrounding
 * `<box paddingLeft={3}>` placement.
 */
export function AssistantLabelLine(input: {
  theme: SessionPalette;
  assistantLabel: string;
  modelLabel: string;
}) {
  return (
    <text marginTop={1}>
      <span style={{ fg: input.theme.accent }}>▣ </span>
      <span style={{ fg: input.theme.text }}>{input.assistantLabel}</span>
      <span style={{ fg: input.theme.textMuted }}> · {input.modelLabel}</span>
    </text>
  );
}

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

/**
 * A long fenced code block lifted out of committed assistant prose (Pillar 2a),
 * folded to `CODE_COLLAPSED_LINE_LIMIT` lines with a click-to-expand affordance. The
 * expand state is a local signal (not persisted): a committed message's identity is
 * stable, so the state survives its lifetime, and there is no per-tool cache to key
 * against for prose code.
 */
function CollapsibleCodeBlock(input: {
  content: string;
  lang: string | undefined;
  theme: SessionPalette;
}) {
  const shellContext = useShellRenderContext();
  const renderer = useRenderer();
  const syntax = createSyntaxStyleMemo(() => getTranscriptSyntaxStyle(input.theme));
  const [expanded, setExpanded] = createSignal(false);
  const collapsed = createMemo(() =>
    collapseCodeContent({
      content: input.content,
      limit: CODE_COLLAPSED_LINE_LIMIT,
      // The pager export ("static") expands every fold — a hint is inert in `less`.
      expanded: expanded() || shellContext.folding() === "static",
      maxLineWidth: COLLAPSED_LINE_CHAR_LIMIT,
    }),
  );
  const toggle = () => {
    if (!collapsed().collapsible) {
      return;
    }
    if (renderer.getSelection()?.getSelectedText()) {
      return;
    }
    setExpanded((value) => !value);
  };
  const collapseHint = createMemo(() =>
    formatCollapseHint({
      expanded: expanded(),
      hiddenLineCount: collapsed().hiddenLineCount,
      totalLineCount: collapsed().totalLineCount,
    }),
  );
  return (
    <box flexDirection="column" gap={0} onMouseUp={toggle}>
      <code
        fg={input.theme.text}
        filetype={input.lang}
        syntaxStyle={syntax()}
        content={collapsed().visibleContent}
      />
      <Show when={collapsed().collapsible && shellContext.folding() === "interactive"}>
        <text fg={input.theme.textMuted}>{collapseHint()}</text>
      </Show>
    </box>
  );
}

function TranscriptTextBlockView(input: {
  content: string;
  theme: SessionPalette;
  markdownStreaming: boolean;
}) {
  const classification = createMemo(() => classifyTranscriptTextBlock({ content: input.content }));
  const mermaidSource = createMemo(() => {
    const current = classification();
    return current.kind === "mermaid" ? current.source : undefined;
  });
  // Only committed (non-streaming) text is split, and only when it actually carries
  // a long fenced code block — otherwise the whole content renders as one markdown
  // block exactly as before (no prose fragmentation, no mid-stream reflow).
  const foldableSegments = createMemo(() => {
    if (input.markdownStreaming) {
      return undefined;
    }
    // Lift only blocks that will actually fold (body > limit), so an exactly-limit
    // block is not fragmented out of prose for zero fold benefit.
    const segments = splitFoldableCodeBlocks(input.content, CODE_COLLAPSED_LINE_LIMIT + 1);
    return segments.some((segment) => segment.kind === "code") ? segments : undefined;
  });
  return (
    <Switch>
      <Match when={mermaidSource()}>
        {(source) => <MermaidBlock source={source()} theme={input.theme} />}
      </Match>
      <Match when={foldableSegments()}>
        {(segments) => (
          <box flexDirection="column" gap={0}>
            <For each={segments()}>
              {(segment) =>
                segment.kind === "code" ? (
                  <CollapsibleCodeBlock
                    content={segment.content}
                    lang={segment.lang}
                    theme={input.theme}
                  />
                ) : (
                  <MarkdownTranscriptBlock
                    content={segment.content}
                    theme={input.theme}
                    streaming={false}
                  />
                )
              }
            </For>
          </box>
        )}
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
  const spacing = useTranscriptRowSpacing();
  const tone = createMemo(() =>
    resolveInlineToolTone({
      status: input.part.status,
      hovered: hovered(),
      actionable: actionable(),
      mutedColor: input.theme.textMuted,
      accentColor: input.theme.accent,
      errorColor: input.theme.error,
      fallbackColor: safetyToneColor(input.theme, input.part.safety.tone),
    }),
  );
  return (
    <box
      id={`tool-${input.part.id}`}
      marginTop={spacing.compactTop() ? 0 : 1}
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
}) {
  const content = createMemo(() => input.part.text.trim());
  return (
    <Show when={content().length > 0}>
      <box id={`text-${input.part.id}`} paddingLeft={3} marginTop={1} flexShrink={0}>
        <TranscriptTextBlockView
          content={content()}
          theme={input.theme}
          markdownStreaming={input.part.renderMode === "streaming"}
        />
      </box>
    </Show>
  );
}

function ReasoningPartView(input: {
  part: Extract<CliShellTranscriptPart, { type: "reasoning" }>;
  theme: SessionPalette;
}) {
  const shellContext = useShellRenderContext();
  const renderer = useRenderer();
  const content = createMemo(() => input.part.text.replace("[REDACTED]", "").trim());
  const streaming = createMemo(() => input.part.renderMode === "streaming");
  const codeStreaming = createPersistentStreamingCodePath(streaming);
  const reasoningSyntax = createSyntaxStyleMemo(() => getReasoningSyntaxStyle(input.theme));
  const summary = createMemo(() => summarizeReasoning(content()));
  const [expanded, setExpanded] = createSignal(false);
  // Collapse committed reasoning to its title line so it stops drowning the turn
  // (density-first, same posture as code folding). Keep it fully visible while it
  // streams — the reader watches it think — and when there is nothing to hide.
  const collapsed = createMemo(
    () =>
      shellContext.folding() === "interactive" && !streaming() && !expanded() && summary().hasMore,
  );
  const toggle = () => {
    if (streaming() || !summary().hasMore) {
      return;
    }
    if (renderer.getSelection()?.getSelectedText()) {
      return;
    }
    setExpanded((value) => !value);
  };
  return (
    <Show when={shellContext.showThinking() && content().length > 0}>
      <box
        id={`text-${input.part.id}`}
        paddingLeft={2}
        marginTop={1}
        flexDirection="column"
        border={["left"]}
        borderColor={input.theme.backgroundElement}
        onMouseUp={toggle}
      >
        <Show
          when={collapsed()}
          fallback={
            <code
              filetype="markdown"
              drawUnstyledText={!codeStreaming()}
              streaming={codeStreaming()}
              syntaxStyle={reasoningSyntax()}
              content={`_Thinking:_ ${content()}`}
              fg={input.theme.textMuted}
            />
          }
        >
          <text fg={input.theme.textMuted}>▸ Thought: {summary().title}</text>
        </Show>
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

function WriteToolView(input: {
  part: CliShellTranscriptToolPart;
  theme: SessionPalette;
  toolRenderCache: ToolRenderCache;
}) {
  const shellContext = useShellRenderContext();
  const path = createMemo(() => readToolPath(input.part) ?? "file");
  const content = createMemo(() => readToolTextInput(input.part) ?? "");
  const writeSyntax = createSyntaxStyleMemo(() => getTranscriptSyntaxStyle(input.theme));
  const interactionState = readTranscriptToolInteractionState(
    input.toolRenderCache,
    input.part.toolCallId,
  );
  const [expanded, setExpanded] = createSignal(Boolean(interactionState.writeExpanded));
  const collapsed = createMemo(() =>
    collapseCodeContent({
      content: content(),
      limit: CODE_COLLAPSED_LINE_LIMIT,
      expanded: expanded() || shellContext.folding() === "static",
      maxLineWidth: COLLAPSED_LINE_CHAR_LIMIT,
    }),
  );
  const toggleExpanded = () => {
    if (!collapsed().collapsible) {
      return;
    }
    const next = !expanded();
    interactionState.writeExpanded = next;
    setExpanded(next);
  };
  const collapseHint = createMemo(() =>
    formatCollapseHint({
      expanded: expanded(),
      hiddenLineCount: collapsed().hiddenLineCount,
      totalLineCount: collapsed().totalLineCount,
    }),
  );
  return (
    <Switch>
      <Match when={content().length > 0 && input.part.status === "completed"}>
        <BlockTool
          title={formatOperatorSafetyShellTitle(input.part.safety, `Wrote ${path()}`)}
          part={input.part}
          theme={input.theme}
          onSelect={collapsed().collapsible ? toggleExpanded : undefined}
        >
          <box paddingLeft={1} flexDirection="column" gap={0}>
            <code
              fg={input.theme.text}
              filetype={inferFiletype(path())}
              syntaxStyle={writeSyntax()}
              content={collapsed().visibleContent}
            />
            <Show when={collapsed().collapsible && shellContext.folding() === "interactive"}>
              <text fg={input.theme.textMuted}>{collapseHint()}</text>
            </Show>
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
// Whole-file writes (and assistant fenced code) fold to this many lines. Larger
// than the exec/generic caps because code is denser and more often worth reading
// than shell chatter, but still bounded so a 400-line write cannot flood the view.
const CODE_COLLAPSED_LINE_LIMIT = 16;
// Cap the width of a collapsed line so a single huge line (e.g. 200KB of
// minified output on one line) can't blow up the render — line-count collapse
// alone lets it through. Expanding restores the untruncated text.
const COLLAPSED_LINE_CHAR_LIMIT = 2000;

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
  writeExpanded?: boolean;
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
  const shellContext = useShellRenderContext();
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
    const source = summaryLines().length > 0 ? summaryLines() : outputLines();
    return source
      .slice(0, EXEC_COLLAPSED_LINE_LIMIT)
      .map((line) => capLineWidth(line, COLLAPSED_LINE_CHAR_LIMIT));
  });
  const collapsible = createMemo(
    () => outputLines().length > EXEC_COLLAPSED_LINE_LIMIT || summaryLines().length > 0,
  );
  const visibleOutputLines = createMemo(() =>
    collapsible() && !expanded() && shellContext.folding() === "interactive"
      ? collapsedOutputLines()
      : outputLines(),
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
            <Show when={collapsible() && shellContext.folding() === "interactive"}>
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
  // The pager export ("static") expands every fold; the local toggle still drives
  // the live view. Used for render/visibility decisions only, never the toggle state.
  const effectiveExpanded = createMemo(() => expanded() || shellContext.folding() === "static");
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
      expanded: effectiveExpanded(),
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
    return effectiveExpanded() ? defaultExpandedResultText() : defaultCollapsedResultText();
  });
  const usesCollapsedDisplaySummary = createMemo(
    () =>
      !effectiveExpanded() &&
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
    resultCollapsible() && !effectiveExpanded()
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
            <Show when={resultCollapsible() && shellContext.folding() === "interactive"}>
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

function ToolPartView(input: {
  part: CliShellTranscriptToolPart;
  theme: SessionPalette;
  toolDefinitions: ReadonlyMap<string, BrewvaToolDefinition>;
  toolRenderCache: ToolRenderCache;
  transcriptWidth: number;
  showDetails: boolean;
}) {
  return (
    <Switch>
      <Match when={input.part.toolName === "read"}>
        <ReadToolView part={input.part} theme={input.theme} />
      </Match>
      <Match when={input.part.toolName === "write"}>
        <WriteToolView
          part={input.part}
          theme={input.theme}
          toolRenderCache={input.toolRenderCache}
        />
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
  showAssistantLabel?: boolean;
  assistantLabel: string;
  modelLabel: string;
}) {
  return (
    <>
      <Index each={input.message.parts}>
        {(part) => {
          const current = part();
          if (current.type === "text") {
            return <TextPartView part={current} theme={input.theme} />;
          }
          if (current.type === "reasoning") {
            return <ReasoningPartView part={current} theme={input.theme} />;
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
              />
            );
          }
          return null;
        }}
      </Index>
      <Show
        when={
          input.showAssistantLabel ?? (input.isLast || input.message.renderMode !== "streaming")
        }
      >
        <box paddingLeft={3}>
          <AssistantLabelLine
            theme={input.theme}
            assistantLabel={input.assistantLabel}
            modelLabel={input.modelLabel}
          />
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
}) {
  return (
    <Index each={input.message.parts}>
      {(part) => {
        const current = part();
        if (current.type === "text") {
          return <TextPartView part={current} theme={input.theme} />;
        }
        if (current.type === "reasoning") {
          return <ReasoningPartView part={current} theme={input.theme} />;
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
  showAssistantLabel?: boolean;
  assistantLabel: string;
  modelLabel: string;
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
        showAssistantLabel={input.showAssistantLabel}
        assistantLabel={input.assistantLabel}
        modelLabel={input.modelLabel}
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
      />
    );
  }
  return <NoteMessageView message={input.message} theme={input.theme} label="Note" />;
}
