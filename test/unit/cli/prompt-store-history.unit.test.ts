import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliShellPromptStore } from "../../../packages/brewva-cli/src/shell/domain/prompt-store.js";
import { waitUntil } from "../../helpers/process.js";

describe("cli prompt store history", () => {
  test("suppresses an adjacent duplicate submission but keeps non-adjacent repeats", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "brewva-prompt-store-"));
    try {
      const store = createCliShellPromptStore({ rootDir });
      store.appendHistory({ text: "hello", parts: [] });
      store.appendHistory({ text: "hello", parts: [] });
      store.appendHistory({ text: "world", parts: [] });
      store.appendHistory({ text: "hello", parts: [] });
      expect(store.loadHistory().map((entry) => entry.text)).toEqual(["hello", "world", "hello"]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("persists the ui theme so it survives a fresh store instance (restart)", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "brewva-ui-prefs-"));
    try {
      const store = createCliShellPromptStore({ rootDir });
      expect(store.loadUiTheme()).toBe(undefined);
      store.saveUiTheme("nord");
      expect(store.loadUiTheme()).toBe("nord");
      // Persistence is fire-and-forget; a fresh store (a restart) reads it back.
      await waitUntil(
        () => createCliShellPromptStore({ rootDir }).loadUiTheme() === "nord",
        2000,
        "ui theme was not persisted to disk",
      );
      expect(createCliShellPromptStore({ rootDir }).loadUiTheme()).toBe("nord");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("persists view and diff prefs across a fresh store instance (restart)", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "brewva-ui-prefs-vd-"));
    try {
      const store = createCliShellPromptStore({ rootDir });
      store.saveUiView({ toolDetails: false, showThinking: false });
      store.saveUiDiff({ style: "stacked", wrapMode: "none" });
      expect(store.loadUiView()).toEqual({ toolDetails: false, showThinking: false });
      expect(store.loadUiDiff()).toEqual({ style: "stacked", wrapMode: "none" });
      await waitUntil(
        () => createCliShellPromptStore({ rootDir }).loadUiDiff()?.style === "stacked",
        2000,
        "view/diff prefs were not persisted to disk",
      );
      const reopened = createCliShellPromptStore({ rootDir });
      expect(reopened.loadUiView()).toEqual({ toolDetails: false, showThinking: false });
      expect(reopened.loadUiDiff()).toEqual({ style: "stacked", wrapMode: "none" });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("serializes rapid cross-key saves without losing an update", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "brewva-ui-prefs-race-"));
    try {
      const store = createCliShellPromptStore({ rootDir });
      // Three saves to distinct keys scheduled back-to-back. The serialized write
      // chain always emits the LATEST merged snapshot, so a fresh store must see
      // all three — a fire-and-forget snapshot race would drop whichever write
      // finished last-but-was-scheduled-earlier.
      store.saveUiTheme("paper");
      store.saveUiView({ toolDetails: true, showThinking: false });
      store.saveUiDiff({ style: "stacked", wrapMode: "none" });
      await waitUntil(
        () => {
          const fresh = createCliShellPromptStore({ rootDir });
          return (
            fresh.loadUiTheme() === "paper" &&
            fresh.loadUiView()?.toolDetails === true &&
            fresh.loadUiDiff()?.style === "stacked"
          );
        },
        2000,
        "a cross-key ui-prefs save was lost (write race)",
      );
      const reopened = createCliShellPromptStore({ rootDir });
      expect(reopened.loadUiTheme()).toBe("paper");
      expect(reopened.loadUiView()).toEqual({ toolDetails: true, showThinking: false });
      expect(reopened.loadUiDiff()).toEqual({ style: "stacked", wrapMode: "none" });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
