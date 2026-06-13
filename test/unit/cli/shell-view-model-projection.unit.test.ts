import { describe, expect, test } from "bun:test";
import {
  createCliShellState,
  reduceCliShellState,
} from "../../../packages/brewva-cli/src/shell/domain/state.js";
import {
  createShellViewModelProjector,
  projectShellViewModel,
} from "../../../packages/brewva-cli/src/shell/domain/view-model.js";

describe("shell view model projection", () => {
  test("identical state returns the identical projection object", () => {
    const project = createShellViewModelProjector();
    const state = createCliShellState();
    expect(project(state)).toBe(project(state));
  });

  test("unchanged branches keep reference identity across commits", () => {
    const project = createShellViewModelProjector();
    const initial = createCliShellState();
    const first = project(initial);

    const afterTranscript = reduceCliShellState(initial, {
      type: "transcript.setMessages",
      messages: [
        {
          id: "assistant:1",
          role: "assistant",
          renderMode: "streaming",
          parts: [{ id: "assistant:1:text:0", type: "text", text: "hi", renderMode: "streaming" }],
        },
      ],
    });
    const second = project(afterTranscript);

    expect(second).not.toBe(first);
    expect(second.transcript).not.toBe(first.transcript);
    expect(second.transcript.messages).toHaveLength(1);
    // Every untouched branch must be the same object so the renderer's
    // reconcile pass short-circuits it without diffing.
    expect(second.composer).toBe(first.composer);
    expect(second.cockpit).toBe(first.cockpit);
    expect(second.notifications).toBe(first.notifications);
    expect(second.queue).toBe(first.queue);
    expect(second.status).toBe(first.status);
    expect(second.overlay).toBe(first.overlay);
    expect(second.focus).toBe(first.focus);
    expect(second.surface).toBe(first.surface);
    expect(second.operator).toBe(first.operator);
    expect(second.diff).toBe(first.diff);
    expect(second.view).toBe(first.view);
  });

  test("changed branches are freshly projected with cloned containers", () => {
    const project = createShellViewModelProjector();
    const initial = createCliShellState();
    const first = project(initial);

    const afterComposer = reduceCliShellState(initial, {
      type: "composer.setText",
      text: "hello",
      cursor: 5,
    });
    const second = project(afterComposer);

    expect(second.composer).not.toBe(first.composer);
    expect(second.composer.text).toBe("hello");
    expect(second.transcript).toBe(first.transcript);
  });

  test("one-shot projection clones every branch", () => {
    const state = createCliShellState();
    const projection = projectShellViewModel(state);
    expect(projection.transcript).not.toBe(state.transcript);
    expect(projection.transcript.messages).not.toBe(state.transcript.messages);
    expect(projection.composer).not.toBe(state.composer);
  });
});
