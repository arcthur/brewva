import { describe, expect, test } from "bun:test";
import { parseSolutionDocument } from "@brewva/brewva-tools/memory";

describe("solution record parsing", () => {
  test("fails fast when frontmatter contains malformed YAML", () => {
    expect(() =>
      parseSolutionDocument(
        [
          "---",
          "title: Broken solution",
          "source_artifacts: [investigation_record",
          "---",
          "# Broken solution",
          "",
          "## Problem",
          "",
          "Body",
        ].join("\n"),
      ),
    ).toThrow("invalid frontmatter");
  });
});
