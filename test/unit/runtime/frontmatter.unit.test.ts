import { describe, expect, test } from "bun:test";
import { parseMarkdownFrontmatter } from "@brewva/brewva-runtime/internal";

describe("parseMarkdownFrontmatter", () => {
  test("returns empty metadata when the document has no frontmatter", () => {
    expect(parseMarkdownFrontmatter("# Heading\n\nBody text")).toEqual({
      data: {},
      body: "# Heading\n\nBody text",
      rawMatter: "",
      hasFrontmatter: false,
    });
  });

  test("parses YAML metadata and normalizes CRLF bodies", () => {
    const parsed = parseMarkdownFrontmatter(
      [
        "---",
        "title: Example",
        "count: 3",
        "enabled: true",
        "tags:",
        "  - wal",
        "selection:",
        "  when_to_use: Review parser changes",
        "  examples:",
        "    - frontmatter parsing",
        "---",
        "# Example",
        "",
        "Body",
      ].join("\r\n"),
    );

    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.rawMatter).toContain("selection:");
    expect(parsed.data).toEqual({
      title: "Example",
      count: 3,
      enabled: true,
      tags: ["wal"],
      selection: {
        when_to_use: "Review parser changes",
        examples: ["frontmatter parsing"],
      },
    });
    expect(parsed.body).toBe("# Example\n\nBody");
  });

  test("accepts UTF-8 BOM and treats comment-only frontmatter as empty metadata", () => {
    expect(parseMarkdownFrontmatter("\uFEFF---\n# comment\n---\nbody")).toEqual({
      data: {},
      body: "body",
      rawMatter: "# comment",
      hasFrontmatter: true,
    });
  });

  test("accepts opening delimiters with trailing whitespace", () => {
    expect(parseMarkdownFrontmatter("---   \ntitle: Example\n---\nbody")).toEqual({
      data: {
        title: "Example",
      },
      body: "body",
      rawMatter: "title: Example",
      hasFrontmatter: true,
    });
  });

  test("rejects malformed YAML", () => {
    expect(() => parseMarkdownFrontmatter("---\ntitle: [unterminated\n---\nbody")).toThrow(
      "invalid frontmatter",
    );
  });

  test("rejects non-object YAML roots", () => {
    expect(() => parseMarkdownFrontmatter("---\n- wal\n- recovery\n---\nbody")).toThrow(
      "must parse to an object",
    );
  });
});
