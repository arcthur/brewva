import { describe, expect, test } from "bun:test";
import {
  FocusManager,
  OverlayManager,
} from "../../../../packages/brewva-cli/src/internal/tui/index.js";

describe("tui focus and overlay state", () => {
  test("restores the previous focus owner after a modal overlay closes", () => {
    type FocusOwner = "approvalOverlay" | "composer" | "transcript";
    const focus = new FocusManager<FocusOwner>("composer");
    const overlays = new OverlayManager();

    focus.setActive("transcript");
    overlays.open({
      id: "approval:1",
      kind: "approval",
      focusOwner: "approvalOverlay",
      priority: "queued",
      suspendFocusOwner: focus.getActive(),
    });
    focus.pushReturn("transcript");
    focus.setActive("approvalOverlay");

    overlays.close("approval:1");
    focus.restore();

    expect(focus.getActive()).toBe("transcript");
    expect(overlays.getActive()).toBe(undefined);
  });

  test("queues later priority overlays instead of replacing the active one", () => {
    const overlays = new OverlayManager();

    overlays.open({
      id: "approval:1",
      kind: "approval",
      focusOwner: "approvalOverlay",
      priority: "queued",
    });
    overlays.open({
      id: "question:1",
      kind: "question",
      focusOwner: "questionOverlay",
      priority: "queued",
    });

    expect(overlays.getActive()?.id).toBe("approval:1");
    expect(overlays.getQueued().map((entry) => entry.id)).toEqual(["question:1"]);
  });
});
