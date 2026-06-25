import { describe, expect, test } from "bun:test";
import {
  decodeToken,
  encodeToken,
  encodeTokensToColumn,
  encodeTokensToMatchExpression,
} from "../../../packages/brewva-session-index/src/sqlite/surrogate.js";

// The surrogate codec is the WS1 foundation that keeps FTS5's tokenizer a true
// passthrough (no CJK re-segmentation). These assertions lock the invariants the
// engine swap relies on.

const TOKENS = ["sqlite", "知识", "图谱", "café", "with space", "x", ""];

describe("FTS5 surrogate token codec", () => {
  test("encodes every token to a pure-ASCII atomic symbol (no whitespace/non-ascii)", () => {
    for (const token of TOKENS.filter((candidate) => candidate.length > 0)) {
      const encoded = encodeToken(token);
      expect(/^[A-Za-z0-9]+$/.test(encoded)).toBe(true);
    }
  });

  test("round-trips back to the original token, including CJK and accents", () => {
    for (const token of ["sqlite", "知识图谱", "café", "x"]) {
      expect(decodeToken(encodeToken(token))).toBe(token);
    }
  });

  test("is deterministic — the same token always yields the same symbol", () => {
    expect(encodeToken("知识")).toBe(encodeToken("知识"));
  });

  test("distinct tokens yield distinct symbols", () => {
    expect(encodeToken("知识")).not.toBe(encodeToken("图谱"));
    expect(encodeToken("sql")).not.toBe(encodeToken("sqlite"));
  });

  test("encodeTokensToColumn joins encoded symbols with single spaces", () => {
    const body = encodeTokensToColumn(["知识", "图谱"]);
    expect(body).toBe(`${encodeToken("知识")} ${encodeToken("图谱")}`);
    expect(/^[A-Za-z0-9 ]+$/.test(body)).toBe(true);
  });

  test("encodeTokensToMatchExpression ORs quoted encoded terms", () => {
    const expr = encodeTokensToMatchExpression(["知识", "图谱"]);
    expect(expr).toBe(`"${encodeToken("知识")}" OR "${encodeToken("图谱")}"`);
  });
});
