import type { Api, AssistantMessage, Model, Usage } from "../types.js";

function createEmptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function createAssistantMessage<TApi extends Api>(
  model: Model<TApi>,
  api: TApi = model.api,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api,
    provider: model.provider,
    model: model.id,
    usage: createEmptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export function resetAssistantMessage(output: AssistantMessage): void {
  output.content = [];
  output.responseId = undefined;
  output.usage = createEmptyUsage();
  output.stopReason = "stop";
  output.errorMessage = undefined;
  output.timestamp = Date.now();
}
