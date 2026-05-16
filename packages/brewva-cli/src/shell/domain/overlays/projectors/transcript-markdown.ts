import {
  transcriptRoleLabel,
  type CliShellTranscriptMessage,
  type CliShellTranscriptPart,
} from "../../transcript.js";

function stringifyForMarkdown(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

function renderTranscriptContentPart(part: CliShellTranscriptPart): string[] {
  switch (part.type) {
    case "text":
      return part.text.split(/\r?\n/u);
    case "reasoning":
      return [
        part.redacted ? "> [reasoning redacted]" : "> [reasoning]",
        ...part.text.split(/\r?\n/u).map((line) => `> ${line}`),
      ];
    case "tool": {
      const lines = [`tool=${part.toolName} status=${part.status} toolCallId=${part.toolCallId}`];
      if (part.args !== undefined) {
        lines.push("args:", stringifyForMarkdown(part.args));
      }
      const result = part.result ?? part.partialResult;
      if (result?.content.length) {
        lines.push("result:");
        for (const content of result.content) {
          switch (content.type) {
            case "text":
              lines.push(content.text);
              break;
            case "thinking":
              lines.push(content.redacted ? "[thinking redacted]" : content.thinking);
              break;
            case "toolCall":
              lines.push(`toolCall=${content.name} id=${content.id}`);
              break;
            case "image":
              lines.push(`image=${content.mimeType} bytes=${content.data.length}`);
              break;
            default:
              content satisfies never;
          }
        }
      }
      if (result?.details !== undefined) {
        lines.push("details:", stringifyForMarkdown(result.details));
      }
      return ["```text", ...lines, "```"];
    }
    default:
      part satisfies never;
      return [];
  }
}

export function renderTranscriptAsMarkdown(
  messages: readonly CliShellTranscriptMessage[],
): string[] {
  const lines = ["# Transcript", ""];
  for (const message of messages) {
    lines.push(`## ${transcriptRoleLabel(message.role)}`, "");
    for (const part of message.parts) {
      lines.push(...renderTranscriptContentPart(part), "");
    }
  }
  if (messages.length === 0) {
    lines.push("No transcript messages are currently projected.");
  }
  return lines;
}
