/** @jsxImportSource @opentui/solid */

import type { BrewvaToolDefinition } from "@brewva/brewva-substrate";
import { For, Match, Show, Switch, createMemo } from "solid-js";
import type {
  CliShellTranscriptMessage,
  CliShellTranscriptPart,
  CliShellTranscriptToolPart,
} from "../../src/shell/transcript.js";
import {
  SPLIT_BORDER_CHARS,
  getReasoningSyntaxStyle,
  getTranscriptSyntaxStyle,
  type SessionPalette,
} from "./palette.js";
import {
  formatUnknown,
  inferFiletype,
  readToolDiffText,
  readToolErrorText,
  readToolPath,
  readToolRangeSuffix,
  readToolResultText,
  readToolTextInput,
  readToolCommand,
  renderToolComponentLines,
  summarizeInput,
  toolStatusText,
  truncateText,
  type ToolRenderCache,
} from "./tool-render.js";

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

function InlineTool(input: {
  icon: string;
  pending: string;
  complete: boolean;
  text: string;
  part: CliShellTranscriptToolPart;
  theme: SessionPalette;
  errorText?: string;
}) {
  const tone = createMemo(() => {
    if (input.part.status === "error") {
      return input.theme.error;
    }
    return input.complete ? input.theme.textMuted : input.theme.text;
  });
  return (
    <box id={`tool-${input.part.id}`} marginTop={1} paddingLeft={3} flexDirection="column">
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
  children: unknown;
}) {
  return (
    <box
      id={`tool-${input.part.id}`}
      border={["left"]}
      customBorderChars={SPLIT_BORDER_CHARS}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      marginTop={1}
      gap={1}
      backgroundColor={input.theme.backgroundPanel}
      borderColor={input.theme.background}
      flexDirection="column"
    >
      <text paddingLeft={3} fg={input.titleColor ?? input.theme.textMuted}>
        {input.title}
      </text>
      {input.children}
      <Show when={readToolErrorText(input.part)}>
        <text paddingLeft={3} fg={input.theme.error}>
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
  return (
    <Show when={input.part.text.trim().length > 0}>
      <box id={`text-${input.part.id}`} paddingLeft={3} marginTop={1} flexShrink={0}>
        <Show
          when={input.message.renderMode !== "streaming" && input.part.renderMode !== "streaming"}
          fallback={
            <code
              filetype="markdown"
              drawUnstyledText={true}
              streaming={true}
              syntaxStyle={getTranscriptSyntaxStyle(input.theme)}
              content={input.part.text.trim()}
              fg={input.theme.text}
            />
          }
        >
          <markdown
            streaming={false}
            syntaxStyle={getTranscriptSyntaxStyle(input.theme)}
            content={input.part.text.trim()}
            conceal={false}
            fg={input.theme.markdownText}
            bg={input.theme.background}
          />
        </Show>
      </box>
    </Show>
  );
}

function ReasoningPartView(input: {
  part: Extract<CliShellTranscriptPart, { type: "reasoning" }>;
  theme: SessionPalette;
}) {
  const content = createMemo(() => input.part.text.replace("[REDACTED]", "").trim());
  return (
    <Show when={content().length > 0}>
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
          drawUnstyledText={true}
          streaming={input.part.renderMode === "streaming"}
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
      pending="Reading file..."
      complete={input.part.status !== "pending"}
      text={text()}
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
        <BlockTool title={`# Wrote ${path()}`} part={input.part} theme={input.theme}>
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
          pending="Preparing write..."
          complete={Boolean(readToolPath(input.part))}
          text={`Write ${path()}`}
          part={input.part}
          theme={input.theme}
          errorText={readToolErrorText(input.part)}
        />
      </Match>
    </Switch>
  );
}

function EditToolView(input: { part: CliShellTranscriptToolPart; theme: SessionPalette }) {
  const path = createMemo(() => readToolPath(input.part) ?? "file");
  const diffText = createMemo(() => readToolDiffText(input.part));
  return (
    <Switch>
      <Match when={diffText().length > 0}>
        <BlockTool title={`← Edit ${path()}`} part={input.part} theme={input.theme}>
          <box paddingLeft={1}>
            <diff
              diff={diffText()}
              view="unified"
              wrapMode="word"
              showLineNumbers={true}
              filetype={inferFiletype(path())}
              syntaxStyle={getTranscriptSyntaxStyle(input.theme)}
              fg={input.theme.text}
              addedBg={input.theme.diffAddedBg}
              removedBg={input.theme.diffRemovedBg}
              contextBg={input.theme.diffContextBg}
              addedSignColor={input.theme.diffHighlightAdded}
              removedSignColor={input.theme.diffHighlightRemoved}
              lineNumberFg={input.theme.diffLineNumber}
              lineNumberBg={input.theme.backgroundElement}
              addedLineNumberBg={input.theme.diffAddedLineNumberBg}
              removedLineNumberBg={input.theme.diffRemovedLineNumberBg}
            />
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="←"
          pending="Preparing edit..."
          complete={Boolean(readToolPath(input.part))}
          text={`Edit ${path()} ${summarizeInput(input.part.args, ["path", "filePath", "file_path"])}`.trim()}
          part={input.part}
          theme={input.theme}
          errorText={readToolErrorText(input.part)}
        />
      </Match>
    </Switch>
  );
}

function BashToolView(input: { part: CliShellTranscriptToolPart; theme: SessionPalette }) {
  const command = createMemo(() => readToolCommand(input.part) ?? "");
  const output = createMemo(() => truncateText(readToolResultText(input.part), 10));
  const title = createMemo(() => {
    const args: Record<string, unknown> = (input.part.args as Record<string, unknown>) ?? {};
    const description = (typeof args.description === "string" ? args.description : null) ?? "Shell";
    const workdir =
      typeof args.workdir === "string" || typeof args.cwd === "string"
        ? ((args.workdir as string | undefined) ?? (args.cwd as string | undefined))
        : undefined;
    if (!workdir || description.includes(workdir)) {
      return `# ${description}`;
    }
    return `# ${description} in ${workdir}`;
  });
  return (
    <Switch>
      <Match
        when={command().length > 0 && (output().length > 0 || input.part.status === "completed")}
      >
        <BlockTool title={title()} part={input.part} theme={input.theme}>
          <box flexDirection="column" gap={0}>
            <text paddingLeft={1} fg={input.theme.text}>
              $ {command()}
            </text>
            <Show when={output().length > 0}>
              <TextLineBlock lines={output().split(/\r?\n/u)} color={input.theme.text} />
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="$"
          pending="Writing command..."
          complete={command().length > 0}
          text={command()}
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
  const callLines = createMemo(() =>
    renderToolComponentLines({
      kind: "call",
      toolDefinitions: input.toolDefinitions,
      toolRenderCache: input.toolRenderCache,
      part: input.part,
      width: input.transcriptWidth,
    }),
  );
  const resultLines = createMemo(() =>
    renderToolComponentLines({
      kind: "result",
      toolDefinitions: input.toolDefinitions,
      toolRenderCache: input.toolRenderCache,
      part: input.part,
      width: input.transcriptWidth,
    }),
  );
  const fallbackCallLines = createMemo(() => {
    if (callLines().length > 0) {
      return callLines();
    }
    return [
      input.part.args !== undefined
        ? `${input.part.toolName} ${formatUnknown(input.part.args)}`
        : input.part.toolName,
    ];
  });
  const resultText = createMemo(() => {
    if (resultLines().length > 0) {
      return resultLines().join("\n");
    }
    return readToolResultText(input.part);
  });

  return (
    <Switch>
      <Match when={!input.showDetails && input.part.status === "completed"}>
        <InlineTool
          icon="⚙"
          pending="Running tool..."
          complete={true}
          text={`${input.part.toolName} ${summarizeInput(input.part.args)}`.trim()}
          part={input.part}
          theme={input.theme}
          errorText={readToolErrorText(input.part)}
        />
      </Match>
      <Match when={resultText().trim().length > 0 || fallbackCallLines().length > 0}>
        <BlockTool
          title={`${input.part.toolName} · ${toolStatusText(input.part)}`}
          part={input.part}
          theme={input.theme}
          titleColor={
            input.part.status === "error"
              ? input.theme.error
              : input.part.status === "completed"
                ? input.theme.success
                : input.theme.warning
          }
        >
          <box flexDirection="column" gap={1}>
            <TextLineBlock lines={fallbackCallLines()} color={input.theme.text} />
            <Show when={resultText().trim().length > 0}>
              <TextLineBlock
                lines={resultText().split(/\r?\n/u)}
                color={input.part.status === "error" ? input.theme.error : input.theme.text}
              />
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="⚙"
          pending="Running tool..."
          complete={input.part.status === "completed"}
          text={`${input.part.toolName} ${summarizeInput(input.part.args)}`.trim()}
          part={input.part}
          theme={input.theme}
          errorText={readToolErrorText(input.part)}
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
      <Match when={input.part.toolName === "edit"}>
        <EditToolView part={input.part} theme={input.theme} />
      </Match>
      <Match when={input.part.toolName === "exec_command" || input.part.toolName === "bash"}>
        <BashToolView part={input.part} theme={input.theme} />
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
