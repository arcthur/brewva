import { describe, expect, test } from "bun:test";
import {
  containsCjk,
  normalizeSearchText,
  tokenizeSearchContent,
  tokenizeSearchQuery,
} from "@brewva/brewva-search";

describe("search tokenizer", () => {
  test("segments Chinese search text with jieba-visible terms", () => {
    const tokens = tokenizeSearchQuery("是否需要jieba分词");

    expect(tokens).toContain("需要");
    expect(tokens).toContain("jieba");
    expect(tokens).toContain("分词");
  });

  test("content tokenization expands code path and identifier subtokens", () => {
    const tokens = tokenizeSearchContent("packages/brewva-runtime/src recall_search");

    expect(tokens).toContain("packages/brewva-runtime/src");
    expect(tokens).toContain("brewva-runtime");
    expect(tokens).toContain("runtime");
    expect(tokens).toContain("recall_search");
    expect(tokens).toContain("recall");
  });

  test("query tokenization keeps compound ASCII tokens conservative", () => {
    const tokens = tokenizeSearchQuery("packages/brewva-runtime/src recall_search");

    expect(tokens).toContain("packages/brewva-runtime/src");
    expect(tokens).toContain("recall_search");
    expect(tokens).not.toContain("brewva-runtime");
    expect(tokens).not.toContain("runtime");
    expect(tokens).not.toContain("recall");
  });

  test("combines CJK and ASCII tokens for mixed queries", () => {
    const tokens = tokenizeSearchQuery("中文 recall_search 分词");

    expect(tokens).toEqual(expect.arrayContaining(["中文", "recall_search", "分词"]));
  });

  test("adds CJK n-grams for unknown compound recall", () => {
    const tokens = tokenizeSearchQuery("数据库连接失败");

    expect(tokens).toEqual(expect.arrayContaining(["数据", "据库", "数据库", "连接", "失败"]));
  });

  test("normalizes text and detects CJK content", () => {
    expect(normalizeSearchText("  Brewva\n中文\tSearch  ")).toBe("brewva 中文 search");
    expect(containsCjk("Brewva 中文 Search")).toBe(true);
    expect(containsCjk("Brewva Search")).toBe(false);
  });

  test("treats CJK compatibility ideographs as Chinese search text", () => {
    const compatibilityText = "\uf900\uf901";

    expect(containsCjk(compatibilityText)).toBe(true);
    expect(tokenizeSearchQuery(compatibilityText)).toContain(compatibilityText);
  });
});
