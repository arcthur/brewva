import { describe, expect, test } from "bun:test";
import type { BrewvaPromptSessionEvent } from "@brewva/brewva-substrate";
import { ShellTranscriptProjector } from "../../../packages/brewva-cli/src/shell/projectors/transcript-projector.js";
import type { CliShellAction } from "../../../packages/brewva-cli/src/shell/state/index.js";
import type { CliShellTranscriptMessage } from "../../../packages/brewva-cli/src/shell/transcript.js";
import { TRUST_LOOP_COPY } from "../../../packages/brewva-cli/src/shell/trust-loop/projection.js";
import type { CliShellUiPort } from "../../../packages/brewva-cli/src/shell/types.js";

function createProjectorHarness() {
  let messages: CliShellTranscriptMessage[] = [];
  const actions: CliShellAction[] = [];
  const projector = new ShellTranscriptProjector({
    getMessages() {
      return messages;
    },
    getSessionId() {
      return "session-1";
    },
    getTranscriptSeed() {
      return [];
    },
    setMessages(nextMessages) {
      messages = [...nextMessages];
    },
    commit(action) {
      actions.push(action);
    },
    getUi() {
      return {
        notify() {},
      } as unknown as CliShellUiPort;
    },
  });

  return { actions, projector };
}

describe("shell transcript projector", () => {
  test("ignores malformed session phases before typed trust projection", () => {
    const { actions, projector } = createProjectorHarness();

    projector.handleSessionEvent({
      type: "session_phase_change",
      phase: {
        kind: "tool_executing",
        toolCallId: "tool-call-1",
      },
    } as unknown as BrewvaPromptSessionEvent);

    expect(actions.some((action) => action.type === "status.setTrust")).toBe(false);
  });

  test("projects idle session phases as product trust copy", () => {
    const { actions, projector } = createProjectorHarness();

    projector.handleSessionEvent({
      type: "session_phase_change",
      phase: { kind: "idle" },
    } as unknown as BrewvaPromptSessionEvent);

    expect(actions).toContainEqual(
      expect.objectContaining({
        type: "status.setTrust",
        trust: expect.objectContaining({
          source: "idle",
          statusText: TRUST_LOOP_COPY.inspectReplayUndo,
        }),
      }),
    );
  });

  test("tool events update transcript trust without fabricating session trust", () => {
    const { actions, projector } = createProjectorHarness();

    projector.handleSessionEvent({
      type: "tool_execution_phase_change",
      toolCallId: "tool-call-1",
      toolName: "read",
      phase: "execute",
      args: { path: "src/app.ts" },
    } as unknown as BrewvaPromptSessionEvent);

    expect(actions.some((action) => action.type === "status.setTrust")).toBe(false);

    projector.handleSessionEvent({
      type: "session_phase_change",
      phase: {
        kind: "tool_executing",
        toolCallId: "tool-call-1",
        toolName: "read",
        turn: 1,
      },
    } as unknown as BrewvaPromptSessionEvent);

    expect(actions).toContainEqual(
      expect.objectContaining({
        type: "status.setTrust",
        trust: expect.objectContaining({
          phase: "inspect",
          source: "tool",
          statusText: "Inspect",
        }),
      }),
    );
  });
});
