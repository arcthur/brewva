import type {
  BrewvaAgentEngineBashExecutionMessage,
  BrewvaAgentEngineBranchSummaryMessage,
  BrewvaAgentEngineCompactionSummaryMessage,
  BrewvaAgentEngineCustomMessage,
  BrewvaAgentEngineLlmMessage,
  BrewvaAgentEngineMessage,
} from "./agent-engine-types.js";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

export type BashExecutionMessage = BrewvaAgentEngineBashExecutionMessage;
export type CustomMessage<T = unknown> = BrewvaAgentEngineCustomMessage<T>;
export type BranchSummaryMessage = BrewvaAgentEngineBranchSummaryMessage;
export type CompactionSummaryMessage = BrewvaAgentEngineCompactionSummaryMessage;

export function bashExecutionToText(msg: BashExecutionMessage): string {
  let text = `Ran \`${msg.command}\`\n`;
  if (msg.output) {
    text += `\`\`\`\n${msg.output}\n\`\`\``;
  } else {
    text += "(no output)";
  }
  if (msg.cancelled) {
    text += "\n\n(command cancelled)";
  } else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
    text += `\n\nCommand exited with code ${msg.exitCode}`;
  }
  if (msg.truncated && msg.fullOutputPath) {
    text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
  }
  return text;
}

export function convertToLlm(messages: BrewvaAgentEngineMessage[]): BrewvaAgentEngineLlmMessage[] {
  return messages
    .map((message): BrewvaAgentEngineLlmMessage | undefined => {
      switch (message.role) {
        case "bashExecution":
          if (message.excludeFromContext) {
            return undefined;
          }
          return {
            role: "user",
            content: [{ type: "text", text: bashExecutionToText(message) }],
            timestamp: message.timestamp,
          };
        case "custom": {
          const content =
            typeof message.content === "string"
              ? [{ type: "text" as const, text: message.content }]
              : message.content;
          return {
            role: "user",
            content,
            timestamp: message.timestamp,
          };
        }
        case "branchSummary":
          return {
            role: "user",
            content: [
              {
                type: "text" as const,
                text: BRANCH_SUMMARY_PREFIX + message.summary + BRANCH_SUMMARY_SUFFIX,
              },
            ],
            timestamp: message.timestamp,
          };
        case "compactionSummary":
          return {
            role: "user",
            content: [
              {
                type: "text" as const,
                text: COMPACTION_SUMMARY_PREFIX + message.summary + COMPACTION_SUMMARY_SUFFIX,
              },
            ],
            timestamp: message.timestamp,
          };
        case "user":
        case "assistant":
        case "toolResult":
          return message;
        default: {
          const _exhaustiveCheck: never = message;
          return _exhaustiveCheck;
        }
      }
    })
    .filter((message): message is BrewvaAgentEngineLlmMessage => message !== undefined);
}
