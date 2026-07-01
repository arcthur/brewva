/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test";
import {
  createOpenTuiSolidElement,
  openTuiSolidAct,
  openTuiSolidTestRender,
  type OpenTuiTextareaHandle,
} from "../../../packages/brewva-cli/runtime/internal-opentui-runtime.js";
import {
  extmarkOffsetToStringOffset,
  stringOffsetToExtmarkOffset,
} from "../../../packages/brewva-cli/src/internal/tui/index.js";

describe("prompt-part extmark offset integration (real OpenTUI textarea)", () => {
  test("a CJK prefix shifts the extmark into display-column space and round-trips back to UTF-16", async () => {
    let handle: OpenTuiTextareaHandle | undefined;
    function Editor() {
      return (
        <textarea
          ref={(node: OpenTuiTextareaHandle) => {
            handle = node;
          }}
          minHeight={1}
        />
      );
    }

    const setup = await openTuiSolidTestRender(createOpenTuiSolidElement(Editor, {}), {
      width: 60,
      height: 6,
    });
    try {
      const node = handle;
      expect(node).toBeDefined();
      if (!node) {
        return;
      }

      // "你好 @file.ts": 你/好 are 1 UTF-16 unit but 2 display columns each, so
      // the token "@file.ts" is UTF-16 [3, 11) yet display columns [5, 13).
      const text = "你好 @file.ts";
      await openTuiSolidAct(async () => {
        node.setText(text);
      });
      // The runtime renderer is a CliRenderer (has `idle()`); narrow back from
      // the test-render setup's wider OpenTuiRenderer type.
      await (setup.renderer as unknown as { idle(): Promise<void> }).idle();
      expect(node.plainText).toBe(text);

      const utf16Start = 3;
      const utf16End = 11;
      expect(text.slice(utf16Start, utf16End)).toBe("@file.ts");

      const typeId = node.extmarks.registerType("brewva-prompt-part-test");
      node.extmarks.create({
        start: stringOffsetToExtmarkOffset(text, utf16Start),
        end: stringOffsetToExtmarkOffset(text, utf16End),
        virtual: true,
        typeId,
      });

      const marks = node.extmarks.getAllForTypeId(typeId);
      expect(marks.length).toBe(1);
      const mark = marks[0];
      expect(mark).toBeDefined();
      if (!mark) {
        return;
      }

      // The extmark is addressed in display-column space — feeding the raw UTF-16
      // offset (3) would land the highlight a column left of the token. This is
      // the regression A1 fixes; it also pins OpenTUI's extmark coordinate unit.
      expect(mark.start).toBe(5);
      expect(mark.end).toBe(13);

      // Reading the extmark back recovers the exact UTF-16 offsets, so the token
      // re-entering prompt-part source.text slices out verbatim.
      const recoveredStart = extmarkOffsetToStringOffset(node.plainText, mark.start);
      const recoveredEnd = extmarkOffsetToStringOffset(node.plainText, mark.end);
      expect(recoveredStart).toBe(utf16Start);
      expect(recoveredEnd).toBe(utf16End);
      expect(node.plainText.slice(recoveredStart, recoveredEnd)).toBe("@file.ts");
    } finally {
      setup.renderer.destroy();
    }
  });
});
