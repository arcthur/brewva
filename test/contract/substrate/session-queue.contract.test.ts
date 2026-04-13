import { describe, expect, test } from "bun:test";
import {
  createInMemorySessionHost,
  type BrewvaPromptEnvelope,
  type BrewvaQueuedPrompt,
} from "@brewva/brewva-substrate";

function prompt(promptId: string, content: string): BrewvaPromptEnvelope {
  return {
    promptId,
    content,
    submittedAt: Number(promptId.replace(/\D+/gu, "") || "0"),
  };
}

function ids(batch: readonly BrewvaQueuedPrompt[]): string[] {
  return batch.map((entry) => entry.promptId);
}

describe("substrate session queue", () => {
  test("delivers steering prompts before follow-ups in one-at-a-time mode", async () => {
    const host = createInMemorySessionHost({
      pluginContext: {
        commands: {
          interrupt() {},
          newSession() {},
          reloadSession() {},
        },
        ui: {
          setStatus() {},
          notify() {},
        },
      },
    });

    host.submitPrompt(prompt("prompt_1", "start"));
    expect(ids(host.releaseNextBatch())).toEqual(["prompt_1"]);

    await host.transition({
      type: "start_tool_execution",
      toolCallId: "tool_1",
      toolName: "read",
      turn: 1,
    });

    host.queueSteer(prompt("steer_1", "steer 1"));
    host.queueSteer(prompt("steer_2", "steer 2"));
    host.queueFollowUp(prompt("follow_1", "follow 1"));
    host.queueFollowUp(prompt("follow_2", "follow 2"));

    await host.transition({ type: "finish_tool_execution" });

    expect(ids(host.releaseNextBatch())).toEqual(["steer_1"]);
    expect(ids(host.releaseNextBatch())).toEqual(["steer_2"]);
    expect(ids(host.releaseNextBatch())).toEqual(["follow_1"]);
    expect(ids(host.releaseNextBatch())).toEqual(["follow_2"]);
    expect(host.releaseNextBatch()).toEqual([]);
  });

  test("batches steering and follow-up prompts in all mode", async () => {
    const host = createInMemorySessionHost({
      pluginContext: {
        commands: {
          interrupt() {},
          newSession() {},
          reloadSession() {},
        },
        ui: {
          setStatus() {},
          notify() {},
        },
      },
    });

    host.setSteeringMode("all");
    host.setFollowUpMode("all");

    host.queueSteer(prompt("steer_1", "steer 1"));
    host.queueSteer(prompt("steer_2", "steer 2"));
    host.queueFollowUp(prompt("follow_1", "follow 1"));
    host.queueFollowUp(prompt("follow_2", "follow 2"));

    expect(ids(host.releaseNextBatch())).toEqual(["steer_1", "steer_2"]);
    expect(ids(host.releaseNextBatch())).toEqual(["follow_1", "follow_2"]);
  });
});
