import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCliShellPromptContentParts } from "../../../packages/brewva-cli/src/shell/domain/prompt-parts.js";

describe("cli prompt parts", () => {
  test("resolves file prompt parts to file URIs only when the attachment exists", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-prompt-parts-"));
    try {
      const attachmentPath = join(cwd, "note.txt");
      writeFileSync(attachmentPath, "hello", "utf8");

      expect(
        buildCliShellPromptContentParts(cwd, "open @note.txt", [
          {
            id: "file-1",
            type: "file",
            path: "note.txt",
            source: {
              text: {
                start: 5,
                end: 14,
                value: "@note.txt",
              },
            },
          },
        ]),
      ).toMatchObject([
        { type: "text", text: "open " },
        {
          type: "file",
          uri: pathToFileURL(realpathSync(attachmentPath)).toString(),
          name: "note.txt",
          displayText: "@note.txt",
        },
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("encodes file prompt line ranges into file URIs", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-prompt-parts-"));
    try {
      const attachmentPath = join(cwd, "note.txt");
      writeFileSync(attachmentPath, "one\ntwo\nthree\n", "utf8");
      const expectedUrl = pathToFileURL(realpathSync(attachmentPath));
      expectedUrl.searchParams.set("start", "2");
      expectedUrl.searchParams.set("end", "3");

      expect(
        buildCliShellPromptContentParts(cwd, "open @note.txt#L2-L3", [
          {
            id: "file-1",
            type: "file",
            path: "note.txt#L2-L3",
            source: {
              text: {
                start: 5,
                end: 20,
                value: "@note.txt#L2-L3",
              },
            },
          },
        ]),
      ).toMatchObject([
        { type: "text", text: "open " },
        {
          type: "file",
          uri: expectedUrl.toString(),
          name: "note.txt",
          displayText: "@note.txt#L2-L3",
        },
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("fails fast when a referenced file prompt part does not exist", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-prompt-parts-"));
    try {
      expect(() =>
        buildCliShellPromptContentParts(cwd, "open @missing.txt", [
          {
            id: "file-1",
            type: "file",
            path: "missing.txt",
            source: {
              text: {
                start: 5,
                end: 17,
                value: "@missing.txt",
              },
            },
          },
        ]),
      ).toThrow("Prompt attachment not found: missing.txt");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
