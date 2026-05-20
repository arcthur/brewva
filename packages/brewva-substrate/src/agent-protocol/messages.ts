import type { BrewvaAgentProtocolLlmMessage, BrewvaAgentProtocolMessage } from "./types.js";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

export function convertToLlm(
  messages: BrewvaAgentProtocolMessage[],
): BrewvaAgentProtocolLlmMessage[] {
  return messages
    .map((message): BrewvaAgentProtocolLlmMessage | undefined => {
      if (message.excludeFromContext) {
        return undefined;
      }
      switch (message.role) {
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
    .filter((message): message is BrewvaAgentProtocolLlmMessage => message !== undefined);
}
