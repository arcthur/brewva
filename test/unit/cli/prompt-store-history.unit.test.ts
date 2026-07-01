import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliShellPromptStore } from "../../../packages/brewva-cli/src/shell/domain/prompt-store.js";

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
});
