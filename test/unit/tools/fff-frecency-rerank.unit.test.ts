import { describe, expect, test } from "bun:test";
import { rerankGroupedLines } from "../../../packages/brewva-tools/src/families/navigation/grep/advisor.js";

const LINES = ["src/alpha.ts:1:createWidget()", "src/beta.ts:1:createWidget()"];

describe("grep rerank frecency tiebreaker", () => {
  test("ranks the higher-frecency file first when other signals tie", () => {
    const result = rerankGroupedLines({
      baseCwd: "/repo",
      query: "createWidget",
      lines: LINES,
      frecencyByPath: new Map([
        ["src/beta.ts", 500],
        ["src/alpha.ts", 10],
      ]),
    });
    expect(result.lines[0]).toContain("beta.ts");
    expect(result.lines[1]).toContain("alpha.ts");
  });

  test("without a frecency map, original order is preserved (regression guard)", () => {
    const result = rerankGroupedLines({
      baseCwd: "/repo",
      query: "createWidget",
      lines: LINES,
    });
    expect(result.lines[0]).toContain("alpha.ts");
    expect(result.lines[1]).toContain("beta.ts");
  });
});
