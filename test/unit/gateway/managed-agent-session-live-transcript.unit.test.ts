import { describe, expect, test } from "bun:test";
import type {
  BrewvaTurnLoopController,
  BrewvaTurnLoopMessage,
  BrewvaTurnLoopTool,
} from "@brewva/brewva-substrate/turn";
import { ManagedSessionLiveTranscript } from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/live-transcript.js";

function createAgentStub() {
  const calls: string[] = [];
  const replaced: BrewvaTurnLoopMessage[][] = [];
  const appended: BrewvaTurnLoopMessage[] = [];
  const prompts: string[] = [];
  const tools: BrewvaTurnLoopTool[][] = [];
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
    replaceMessages(messages: BrewvaTurnLoopMessage[]) {
      calls.push("replaceMessages");
      replaced.push(messages);
    },
    abort: () => undefined,
    setTools(nextTools: BrewvaTurnLoopTool[]) {
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
    appendMessage(message: BrewvaTurnLoopMessage) {
      calls.push("appendMessage");
      appended.push(message);
    },
    hasQueuedMessages: () => false,
  } as unknown as BrewvaTurnLoopController;
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
      tools: [{ name: "read" } as BrewvaTurnLoopTool],
    });
    transcript.applyBaseSystemPrompt("rebuilt");
    transcript.applyPromptOverlay("overlay");

    expect(calls).toEqual(["setTools", "setSystemPrompt", "setSystemPrompt", "setSystemPrompt"]);
    expect(tools).toHaveLength(1);
    expect(prompts).toEqual(["base", "rebuilt", "overlay"]);
  });
});
