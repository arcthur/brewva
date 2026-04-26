/** @jsxImportSource @opentui/solid */

import type { BrewvaToolDefinition } from "@brewva/brewva-substrate";
import { useRenderer } from "@opentui/solid";
import type { JSX } from "solid-js";
import { For, Index, Match, Show, Switch, createEffect, createMemo, createSignal } from "solid-js";
import type {
  CliShellTranscriptMessage,
  CliShellTranscriptPart,
  CliShellTranscriptToolPart,
} from "../../src/shell/transcript.js";
import { formatTrustLoopTitle, type TrustLoopTone } from "../../src/shell/trust-loop/projection.js";
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
import { classifyTranscriptTextBlock, splitTranscriptTextBlocks } from "./transcript-markdown.js";

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

function trustToneColor(theme: SessionPalette, tone: TrustLoopTone): string {
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
      throw new Error(`Unsupported trust loop tone: ${String(tone)}`);
  }
}

function StableTranscriptTextBlock(input: { content: string; theme: SessionPalette }) {
  const renderer = useRenderer();
  const mermaidSource = createMemo(() => {
    const classified = classifyTranscriptTextBlock({ content: input.content });
    return classified.kind === "mermaid" ? classified.source : undefined;
  });
  const maxBlockWidth = createMemo(() => Math.max(24, renderer.width - 12));
  return (
    <Show
      when={mermaidSource()}
      fallback={<MarkdownTranscriptBlock content={input.content} theme={input.theme} />}
    >
      {(source) => (
        <MermaidBlock source={source()} theme={input.theme} maxWidth={maxBlockWidth()} />
      )}
    </Show>
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
    return trustToneColor(input.theme, input.part.trust.tone);
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
        <text fg={input.titleColor ?? trustToneColor(input.theme, input.part.trust.tone)}>
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
  message: CliShellTranscriptMessage;
  part: Extract<CliShellTranscriptPart, { type: "text" }>;
  theme: SessionPalette;
}) {
  const streaming = createMemo(
    () => input.message.renderMode === "streaming" || input.part.renderMode === "streaming",
  );
  const blocks = createMemo(() => splitTranscriptTextBlocks(input.part.text));
  return (
    <Show when={blocks().length > 0}>
      <box
        id={`text-${input.part.id}`}
        paddingLeft={3}
        marginTop={1}
        flexDirection="column"
        gap={0}
        flexShrink={0}
      >
        <Index each={blocks()}>
          {(block, index) => (
            <box id={`text-${input.part.id}:block:${index}`} marginTop={index === 0 ? 0 : 1}>
              <Show
                when={streaming()}
                fallback={
                  <StableTranscriptTextBlock content={block().content} theme={input.theme} />
                }
              >
                <code
                  filetype="markdown"
                  drawUnstyledText={false}
                  streaming={true}
                  syntaxStyle={getTranscriptSyntaxStyle(input.theme)}
                  content={block().content}
                  fg={input.theme.text}
                />
              </Show>
            </box>
          )}
        </Index>
      </box>
    </Show>
  );
}

function ReasoningPartView(input: {
  part: Extract<CliShellTranscriptPart, { type: "reasoning" }>;
  theme: SessionPalette;
}) {
  const shellContext = useShellRenderContext();
  const content = createMemo(() => input.part.text.replace("[REDACTED]", "").trim());
  const streaming = createMemo(() => input.part.renderMode === "streaming");
  const useStreamingCodePath = createPersistentStreamingCodePath(streaming);
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
        <code
          filetype="markdown"
          drawUnstyledText={!useStreamingCodePath()}
          streaming={useStreamingCodePath()}
          syntaxStyle={getReasoningSyntaxStyle(input.theme)}
          content={`_Thinking:_ ${content()}`}
          fg={input.theme.textMuted}
        />
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
      pending={input.part.trust.statusText}
      complete={input.part.status !== "pending"}
      text={formatTrustLoopTitle(input.part.trust, text())}
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
          title={formatTrustLoopTitle(input.part.trust, `Wrote ${path()}`)}
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
          pending={input.part.trust.statusText}
          complete={Boolean(readToolPath(input.part))}
          text={formatTrustLoopTitle(input.part.trust, `Write ${path()}`)}
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
    return formatTrustLoopTitle(part.trust, `Edit ${path}`);
  }
  if (part.toolName === "apply_patch") {
    return formatTrustLoopTitle(part.trust, `Patch ${path}`);
  }
  return formatTrustLoopTitle(part.trust, `${part.toolName} ${path}`.trim());
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
                title={formatTrustLoopTitle(input.part.trust, formatDiffFileTitle(file))}
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
          pending={input.part.trust.statusText}
          complete={Boolean(readToolPath(input.part))}
          text={formatTrustLoopTitle(
            input.part.trust,
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
      return formatTrustLoopTitle(input.part.trust, description);
    }
    return formatTrustLoopTitle(input.part.trust, `${description} in ${workdir}`);
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
          pending={input.part.trust.statusText}
          complete={command().length > 0}
          text={formatTrustLoopTitle(input.part.trust, command())}
          part={input.part}
          theme={input.theme}
          errorText={readToolErrorText(input.part)}
        />
      </Match>
    </Switch>
  );
}

interface SkillLoadSummary {
  readonly name: string;
  readonly category?: string;
  readonly effectLevel?: string;
  readonly readiness?: string;
  readonly allowedEffects?: string;
  readonly deniedEffects?: string;
  readonly preferredTools?: string;
  readonly fallbackTools?: string;
  readonly requiredOutputs?: string;
  readonly resourceSummary?: string;
}

function readStringRecordValue(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readSkillLoadTopLevelField(text: string, field: string): string | undefined {
  const prefix = `${field}:`;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(prefix)) {
      const value = trimmed.slice(prefix.length).trim();
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

function readSkillLoadBulletField(text: string, field: string): string | undefined {
  const expected = field.toLowerCase();
  for (const line of text.split(/\r?\n/u)) {
    const match = line.trim().match(/^-\s*([^:]+):\s*(.*)$/u);
    if (!match) {
      continue;
    }
    if (match[1]?.trim().toLowerCase() !== expected) {
      continue;
    }
    const value = match[2]?.trim() ?? "";
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

function countListValue(value: string | undefined): number | undefined {
  if (!value || value === "(none)") {
    return undefined;
  }
  const count = value.split(/\s*,\s*/u).filter((item) => item.trim().length > 0).length;
  return count > 0 ? count : undefined;
}

function formatSkillLoadResourceSummary(text: string): string | undefined {
  const resources = [
    ["references", countListValue(readSkillLoadBulletField(text, "references"))],
    ["scripts", countListValue(readSkillLoadBulletField(text, "scripts"))],
    ["heuristics", countListValue(readSkillLoadBulletField(text, "heuristics"))],
    ["invariants", countListValue(readSkillLoadBulletField(text, "invariants"))],
  ] as const;
  const present = resources.flatMap(([label, count]) =>
    count === undefined ? [] : [`${label} ${count}`],
  );
  return present.length > 0 ? present.join(", ") : undefined;
}

function readSkillLoadSummary(part: CliShellTranscriptToolPart): SkillLoadSummary {
  const text = readToolResultText(part);
  const args = asRecord(part.args);
  const details = asRecord(part.result?.details ?? part.partialResult?.details);
  const readiness = asRecord(details?.skillReadiness);
  const titleMatch = text.match(/^# Skill Loaded:\s*(.+)$/mu);
  return {
    name:
      readStringRecordValue(args, "name") ??
      readStringRecordValue(details, "skill") ??
      titleMatch?.[1]?.trim() ??
      "skill",
    category: readSkillLoadTopLevelField(text, "Category"),
    effectLevel: readSkillLoadBulletField(text, "effect level"),
    readiness:
      readSkillLoadBulletField(text, "readiness") ?? readStringRecordValue(readiness, "readiness"),
    allowedEffects: readSkillLoadBulletField(text, "allowed effects"),
    deniedEffects: readSkillLoadBulletField(text, "denied effects"),
    preferredTools: readSkillLoadBulletField(text, "preferred tools"),
    fallbackTools: readSkillLoadBulletField(text, "fallback tools"),
    requiredOutputs: readSkillLoadBulletField(text, "required outputs"),
    resourceSummary: formatSkillLoadResourceSummary(text),
  };
}

function formatSkillLoadTitle(summary: SkillLoadSummary): string {
  return [`Skill "${summary.name}"`, summary.category, summary.effectLevel, summary.readiness]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
}

function SkillLoadToolView(input: {
  part: CliShellTranscriptToolPart;
  theme: SessionPalette;
  showDetails: boolean;
}) {
  const summary = createMemo(() => readSkillLoadSummary(input.part));
  const title = createMemo(() => formatSkillLoadTitle(summary()));
  const detailLines = createMemo(() => {
    const current = summary();
    return [
      current.allowedEffects ? `Allowed: ${current.allowedEffects}` : undefined,
      current.deniedEffects ? `Denied: ${current.deniedEffects}` : undefined,
      current.preferredTools ? `Preferred tools: ${current.preferredTools}` : undefined,
      current.fallbackTools ? `Fallback tools: ${current.fallbackTools}` : undefined,
      current.requiredOutputs ? `Required outputs: ${current.requiredOutputs}` : undefined,
      current.resourceSummary ? `Resources: ${current.resourceSummary}` : undefined,
      input.part.status === "completed" ? "Instructions: loaded into context" : undefined,
    ].filter((line): line is string => Boolean(line));
  });

  return (
    <Switch>
      <Match when={input.showDetails && input.part.status === "completed"}>
        <BlockTool
          title={formatTrustLoopTitle(input.part.trust, title())}
          part={input.part}
          theme={input.theme}
        >
          <TextLineBlock lines={detailLines()} color={input.theme.textMuted} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="→"
          pending={input.part.trust.statusText}
          complete={input.part.status !== "pending"}
          text={formatTrustLoopTitle(input.part.trust, title())}
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
    void shellContext.runtime.openSessionById(sessionId);
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
  const inlineText = createMemo(() => {
    const summary = readToolDisplaySummaryText(input.part);
    if (summary) {
      return formatTrustLoopTitle(
        input.part.trust,
        firstNonEmptyLine(summary) ?? input.part.toolName,
      );
    }
    return formatTrustLoopTitle(
      input.part.trust,
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
    const summary = readToolDisplaySummaryText(input.part);
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
  const collapseHint = createMemo(() =>
    formatCollapseHint({
      expanded: expanded(),
      hiddenLineCount: hiddenLineCount(),
      totalLineCount: totalResultLineCount(),
    }),
  );
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
          pending={input.part.trust.statusText}
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
          title={input.part.trust.title}
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
          pending={input.part.trust.statusText}
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
      <Match when={input.part.toolName === "skill_load"}>
        <SkillLoadToolView part={input.part} theme={input.theme} showDetails={input.showDetails} />
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
  modelLabel: string;
}) {
  return (
    <>
      <For each={input.message.parts}>
        {(part) => {
          if (part.type === "text") {
            return <TextPartView message={input.message} part={part} theme={input.theme} />;
          }
          if (part.type === "reasoning") {
            return <ReasoningPartView part={part} theme={input.theme} />;
          }
          if (part.type === "tool") {
            return (
              <ToolPartView
                part={part}
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
      </For>
      <Show when={input.isLast || input.message.renderMode !== "streaming"}>
        <box paddingLeft={3}>
          <text marginTop={1}>
            <span style={{ fg: input.theme.accent }}>▣ </span>
            <span style={{ fg: input.theme.text }}>Brewva</span>
            <span style={{ fg: input.theme.textMuted }}> · {input.modelLabel}</span>
          </text>
        </box>
      </Show>
    </>
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
        modelLabel={input.modelLabel}
      />
    );
  }
  if (input.message.role === "system") {
    return <NoteMessageView message={input.message} theme={input.theme} label="System" />;
  }
  if (input.message.role === "tool") {
    return <NoteMessageView message={input.message} theme={input.theme} label="Tool" />;
  }
  return <NoteMessageView message={input.message} theme={input.theme} label="Note" />;
}
