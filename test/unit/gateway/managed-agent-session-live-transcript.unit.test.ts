import { describe, expect, test } from "bun:test";
import type {
  BrewvaAgentProtocolController,
  BrewvaAgentProtocolMessage,
  BrewvaAgentProtocolTool,
} from "@brewva/brewva-substrate/agent-protocol";
import { ManagedSessionLiveTranscript } from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/live-transcript.js";

function createAgentStub() {
  const calls: string[] = [];
  const replaced: BrewvaAgentProtocolMessage[][] = [];
  const appended: BrewvaAgentProtocolMessage[] = [];
  const prompts: string[] = [];
  const tools: BrewvaAgentProtocolTool[][] = [];
  const agent = {
    state: {
      model: undefined,
      thinkingLevel: "off",
      isStreaming: false,
      systemPrompt: "",
      tools: [],
    },
    signal: undefined,
    subscribe: () => () => undefined,
    prompt: async () => undefined,
    waitForIdle: async () => undefined,
    setModel: () => undefined,
    setThinkingLevel: () => undefined,
    replaceMessages(messages: BrewvaAgentProtocolMessage[]) {
      calls.push("replaceMessages");
      replaced.push(messages);
    },
    abort: () => undefined,
    setTools(nextTools: BrewvaAgentProtocolTool[]) {
      calls.push("setTools");
      tools.push(nextTools);
    },
    setSystemPrompt(prompt: string) {
      calls.push("setSystemPrompt");
      prompts.push(prompt);
    },
    followUp: () => undefined,
    queue: () => undefined,
    removeQueuedMessage: () => false,
    steer: () => false,
    hasPendingSteer: () => false,
    appendMessage(message: BrewvaAgentProtocolMessage) {
      calls.push("appendMessage");
      appended.push(message);
    },
    hasQueuedMessages: () => false,
  } as unknown as BrewvaAgentProtocolController;
  return { agent, calls, replaced, appended, prompts, tools };
}

describe("managed-agent-session live transcript", () => {
  test("replacePersistedMessages clears provider cache before replacing live messages", async () => {
    const { agent, calls, replaced } = createAgentStub();
    const order: string[] = [];
    const transcript = new ManagedSessionLiveTranscript({
      agent,
      clearProviderCacheSessionState: async () => {
        order.push("clear");
      },
    });

    await transcript.replacePersistedMessages([{ role: "assistant", content: [], timestamp: 1 }]);

    expect(order).toEqual(["clear"]);
    expect(calls[0]).toBe("replaceMessages");
    expect(replaced).toHaveLength(1);
  });

  test("appendCommittedMessage only appends to live agent state", () => {
    const { agent, calls, appended } = createAgentStub();
    const transcript = new ManagedSessionLiveTranscript({
      agent,
      clearProviderCacheSessionState: async () => undefined,
    });

    transcript.appendCommittedMessage({
      role: "custom",
      customType: "note",
      content: "hello",
      display: true,
      timestamp: 1,
    });

    expect(calls).toEqual(["appendMessage"]);
    expect(appended).toHaveLength(1);
  });

  test("applies base context and prompt overlay without mixing responsibilities", () => {
    const { agent, calls, prompts, tools } = createAgentStub();
    const transcript = new ManagedSessionLiveTranscript({
      agent,
      clearProviderCacheSessionState: async () => undefined,
    });

    transcript.applyBaseContext({
      systemPrompt: "base",
      tools: [{ name: "read" } as BrewvaAgentProtocolTool],
    });
    transcript.applyBaseSystemPrompt("rebuilt");
    transcript.applyPromptOverlay("overlay");

    expect(calls).toEqual(["setTools", "setSystemPrompt", "setSystemPrompt", "setSystemPrompt"]);
    expect(tools).toHaveLength(1);
    expect(prompts).toEqual(["base", "rebuilt", "overlay"]);
  });
});
