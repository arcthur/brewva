import { describe, expect, test } from "bun:test";
import {
  applySourceEdits,
  clearParsedSourceCache,
  collectSymbols,
  detectLanguage,
  diffIntroducedFatalParseErrors,
  findIdentifierAtPosition,
  findOccurrences,
  formatSymbolLine,
  isParsableFile,
  isValidIdentifierName,
  lineColumnToOffset,
  offsetToLineColumn,
  parseSource,
  renameInFile,
  walkAst,
  type AstNode,
  type IdentifierOccurrence,
  type OxcError,
  type SourceSymbol,
} from "../../../packages/brewva-tools/src/parsing/index.js";

const COMMENT_AND_STRING_AWARE_SOURCE = `// rename foo here? no
/* foo also lives in a block comment */
const message = "foo lives in this string literal";
const template = \`foo lives in template too\`;
function foo() {
  return foo() + foo.length;
}
const obj = { foo: 1, bar: foo, ['foo']: 9 };
class Widget {
  foo() { return 0; }
  static foo = 1;
}
interface FooT { name: string }
type Bar = FooT;
function shadowed() {
  const foo = "shadow";
  return foo;
}
`;

function namesAt(occurrences: readonly IdentifierOccurrence[]): string[] {
  return occurrences.map((o) => `${o.kind}@${o.line}:${o.column}`);
}

function symbolNames(symbols: readonly SourceSymbol[]): string[] {
  return symbols.map((s) => `${s.kind}:${s.name}`);
}

describe("parsing/oxc-source: language detection", () => {
  test("detectLanguage recognises canonical TS/JS extensions", () => {
    expect(detectLanguage("foo.ts")).toBe("ts");
    expect(detectLanguage("Foo.TSX")).toBe("tsx");
    expect(detectLanguage("foo.d.ts")).toBe("dts");
    expect(detectLanguage("foo.jsx")).toBe("jsx");
    expect(detectLanguage("foo.mjs")).toBe("js");
    expect(detectLanguage("foo.cjs")).toBe("js");
    expect(detectLanguage("foo.go")).toBeNull();
  });

  test("isParsableFile mirrors detectLanguage", () => {
    expect(isParsableFile("a.ts")).toBe(true);
    expect(isParsableFile("a.py")).toBe(false);
  });
});

describe("parsing/oxc-source: position translation", () => {
  test("offsetToLineColumn handles BOL, multi-line, and out-of-range offsets", () => {
    const text = "abc\ndef\n\nxyz";
    expect(offsetToLineColumn(text, 0)).toEqual({ line: 1, column: 0 });
    expect(offsetToLineColumn(text, 1)).toEqual({ line: 1, column: 1 });
    expect(offsetToLineColumn(text, 4)).toEqual({ line: 2, column: 0 });
    expect(offsetToLineColumn(text, 8)).toEqual({ line: 3, column: 0 });
    expect(offsetToLineColumn(text, 9999)).toEqual({ line: 4, column: 3 });
    expect(offsetToLineColumn(text, -1)).toEqual({ line: 1, column: 0 });
  });

  test("lineColumnToOffset is the inverse of offsetToLineColumn", () => {
    const text = "alpha\nbeta gamma\n  delta\n";
    for (let off = 0; off <= text.length; off += 1) {
      const lc = offsetToLineColumn(text, off);
      const back = lineColumnToOffset(text, lc.line, lc.column);
      // back is the same offset unless the original offset is past EOL of that
      // line (then we are clamped to lineEnd, which equals off if off is on
      // the line itself).
      expect(back).toBe(off);
    }
  });

  test("lineColumnToOffset clamps over-long character positions to line end", () => {
    const text = "ab\ncd\n";
    expect(lineColumnToOffset(text, 1, 50)).toBe(2); // line 1 ends at index 2
    expect(lineColumnToOffset(text, 2, 50)).toBe(5); // line 2 ends at index 5
    expect(lineColumnToOffset(text, 99, 0)).toBe(text.length);
  });
});

describe("parsing/oxc-source: parseSource + cache", () => {
  test("parseSource returns AST + module info + comments + scope", () => {
    clearParsedSourceCache();
    const parsed = parseSource(
      "fixture.ts",
      `import { x } from "./x"; export const y = x + 1; // tail comment`,
    );
    expect(parsed.lang).toBe("ts");
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.module.staticImports).toHaveLength(1);
    expect(parsed.module.staticExports).toHaveLength(1);
    expect(parsed.scopeManager.scopes.length).toBeGreaterThan(0);
  });

  test("parseSource caches by content (same content -> same instance)", () => {
    clearParsedSourceCache();
    const a = parseSource("cache.ts", "export const x = 1;");
    const b = parseSource("cache.ts", "export const x = 1;");
    expect(a).toBe(b);
  });

  test("parseSource invalidates the cache when content changes", () => {
    clearParsedSourceCache();
    const a = parseSource("cache.ts", "export const x = 1;");
    const b = parseSource("cache.ts", "export const x = 2;");
    expect(a).not.toBe(b);
  });

  test("parseSource recovers gracefully when source has parse errors", () => {
    clearParsedSourceCache();
    const parsed = parseSource("broken.ts", "function () { ;");
    expect(parsed.errors.length).toBeGreaterThan(0);
    // Even a broken parse must yield a Program-like object so downstream
    // walkers do not crash.
    expect(parsed.program.type).toBe("Program");
  });
});

describe("parsing/oxc-source: walkAst", () => {
  test("walkAst visits every node and supplies parent context", () => {
    clearParsedSourceCache();
    const parsed = parseSource("walk.ts", `function f() { const x = 1; return x; }`);
    const visits: string[] = [];
    const parentTypes: string[] = [];
    walkAst(parsed.program, ({ node, parent }) => {
      visits.push(node.type);
      parentTypes.push(parent ? parent.type : "<root>");
    });
    expect(visits).toContain("FunctionDeclaration");
    expect(visits).toContain("VariableDeclaration");
    expect(visits).toContain("VariableDeclarator");
    expect(visits).toContain("Identifier");
    expect(parentTypes[0]).toBe("<root>");
    // The Identifier inside the function body is not a top-level node.
    expect(parentTypes.some((t) => t !== "<root>")).toBe(true);
  });

  test("walkAst exposes parentKey and parentIndex for arrayed children", () => {
    clearParsedSourceCache();
    const parsed = parseSource("walk-array.ts", `[1, 2, 3]`);
    const literalIndices: Array<number | null> = [];
    walkAst(parsed.program, ({ node, parentKey, parentIndex }) => {
      if (node.type === "Literal" && parentKey === "elements") {
        literalIndices.push(parentIndex);
      }
    });
    expect(literalIndices).toEqual([0, 1, 2]);
  });
});

describe("parsing/oxc-source: collectSymbols", () => {
  test("collectSymbols enumerates JS + TS declarations by line", () => {
    clearParsedSourceCache();
    const parsed = parseSource("symbols.ts", COMMENT_AND_STRING_AWARE_SOURCE);
    const symbols = collectSymbols(parsed, { limit: 200 });
    const names = symbolNames(symbols);
    expect(names).toEqual(
      expect.arrayContaining([
        "const:message",
        "const:template",
        "function:foo",
        "const:obj",
        "class:Widget",
        "method:foo",
        "property:foo",
        "interface:FooT",
        "type:Bar",
        "function:shadowed",
      ]),
    );
  });

  test("collectSymbols respects limit", () => {
    const parsed = parseSource("symbols.ts", COMMENT_AND_STRING_AWARE_SOURCE);
    const symbols = collectSymbols(parsed, { limit: 3 });
    expect(symbols).toHaveLength(3);
  });

  test("collectSymbols filters by case-insensitive query", () => {
    const parsed = parseSource("symbols.ts", COMMENT_AND_STRING_AWARE_SOURCE);
    const symbols = collectSymbols(parsed, { query: "foot" });
    expect(symbols.map((s) => s.name)).toEqual(["FooT"]);
  });

  test("collectSymbols extracts destructured binding names", () => {
    const parsed = parseSource(
      "destructure.ts",
      `const { alpha, beta: renamed, ...rest } = obj; const [first, , third = 0] = arr;`,
    );
    const names = collectSymbols(parsed, { limit: 50 }).map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["alpha", "renamed", "rest", "first", "third"]));
  });

  test("collectSymbols extracts import bindings (named, default, namespace)", () => {
    const parsed = parseSource(
      "imports.ts",
      `import def, { named1, named2 as alias } from "./mod"; import * as ns from "./n";`,
    );
    const names = collectSymbols(parsed, { limit: 50 })
      .filter((s) => s.kind === "import")
      .map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["def", "named1", "alias", "ns"]));
  });
});

describe("parsing/oxc-source: findIdentifierAtPosition", () => {
  test("findIdentifierAtPosition returns the smallest identifier covering the offset", () => {
    const parsed = parseSource("pos.ts", `const longerName = 1;\nconst x = longerName;`);
    // Cursor inside `longerName` on line 2.
    const ident = findIdentifierAtPosition(parsed, 2, 12);
    expect(ident).not.toBeNull();
    expect(ident?.name).toBe("longerName");
    expect(ident?.inTypePosition).toBe(false);
  });

  test("findIdentifierAtPosition flags TS type positions", () => {
    const parsed = parseSource(
      "type-pos.ts",
      `interface Cfg { name: string }\nconst c: Cfg = { name: "x" };`,
    );
    // Cursor on `Cfg` in `const c: Cfg = ...` at line 2 char 9.
    const ident = findIdentifierAtPosition(parsed, 2, 9);
    expect(ident?.name).toBe("Cfg");
    expect(ident?.inTypePosition).toBe(true);
  });

  test("findIdentifierAtPosition returns null when no identifier at offset", () => {
    const parsed = parseSource("blank.ts", `   \n   const x = 1;\n`);
    expect(findIdentifierAtPosition(parsed, 1, 0)).toBeNull();
    expect(findIdentifierAtPosition(parsed, 5, 0)).toBeNull();
  });
});

describe("parsing/oxc-source: findOccurrences (the regex-killer test)", () => {
  test("scope-anchored search ignores comments, strings, properties, AND shadowed inner scopes", () => {
    clearParsedSourceCache();
    const parsed = parseSource("foo.ts", COMMENT_AND_STRING_AWARE_SOURCE);
    // Anchor on the top-level function declaration `function foo()` on line 5.
    const fnDecl = findIdentifierAtPosition(parsed, 5, 9);
    expect(fnDecl?.name).toBe("foo");
    const occurrences = findOccurrences(parsed, "foo", { atOffset: fnDecl!.start });
    const lines = namesAt(occurrences);

    // Definition on the function declaration line + the two body references.
    expect(lines).toContain("value_definition@5:9");
    expect(lines).toContain("value_reference@6:9");
    expect(lines).toContain("value_reference@6:17");
    // The `bar: foo` value usage on line 8 (column 27, not 28: bar:_foo).
    expect(lines).toContain("value_reference@8:27");

    // Property keys, comment text, string content, class members, AND the
    // inner `shadowed()` const named `foo` MUST NOT appear in the result.
    for (const occ of occurrences) {
      expect(occ.line).not.toBe(1); // // rename foo here
      expect(occ.line).not.toBe(2); // /* foo also lives ...
      expect(occ.line).not.toBe(3); // "foo lives in string"
      expect(occ.line).not.toBe(4); // `foo lives in template`
      expect(occ.line).not.toBe(10); // class method foo()
      expect(occ.line).not.toBe(11); // static foo = 1;
      expect(occ.line).not.toBe(16); // const foo = "shadow"
      expect(occ.line).not.toBe(17); // return foo (inner scope)
    }
  });

  test("scope-anchored search anchored at the inner shadow returns ONLY inner-scope occurrences", () => {
    clearParsedSourceCache();
    const parsed = parseSource("shadow.ts", COMMENT_AND_STRING_AWARE_SOURCE);
    const innerDecl = findIdentifierAtPosition(parsed, 16, 8);
    expect(innerDecl?.name).toBe("foo");
    const occurrences = findOccurrences(parsed, "foo", { atOffset: innerDecl!.start });
    const lines = namesAt(occurrences);
    // Only the inner const + inner return reference.
    expect(lines).toEqual(
      expect.arrayContaining(["value_definition@16:8", "value_reference@17:9"]),
    );
    for (const occ of occurrences) {
      expect(occ.line === 16 || occ.line === 17).toBe(true);
    }
  });

  test("scope-anchored tags assignment bindings as value_write", () => {
    clearParsedSourceCache();
    const parsed = parseSource("assign.ts", `let n = 0;\nn = 1;\nn + 2;`);
    const decl = findIdentifierAtPosition(parsed, 1, 4);
    expect(decl?.name).toBe("n");
    const occ = findOccurrences(parsed, "n", { atOffset: decl!.start });
    const kinds = occ.map((o) => `${o.kind}@${o.line}:${o.column}`).toSorted();
    expect(kinds).toContain("value_definition@1:4");
    expect(kinds).toContain("value_write@2:0");
    expect(kinds).toContain("value_reference@3:0");
  });

  test("ast-walk mode resolves TS interface declarations + type references", () => {
    clearParsedSourceCache();
    const parsed = parseSource("type-foo.ts", COMMENT_AND_STRING_AWARE_SOURCE);
    const occurrences = findOccurrences(parsed, "FooT", { mode: "ast-walk" });
    const lines = namesAt(occurrences);
    expect(lines).toEqual(
      expect.arrayContaining(["type_definition@13:10", "type_reference@14:11"]),
    );
  });

  test("AST-walk path (no anchor) is the cross-file find-references default and is name-textual", () => {
    clearParsedSourceCache();
    const parsed = parseSource("crossfile.ts", COMMENT_AND_STRING_AWARE_SOURCE);
    const occurrences = findOccurrences(parsed, "foo");
    // Without an anchor we surface every textual identifier reference (still
    // not comments / strings / property accessors). Both shadowed scopes are
    // returned -- callers must use lsp_diagnostics for type-aware verification.
    const lines = namesAt(occurrences);
    expect(lines).toContain("value_definition@5:9");
    expect(lines).toContain("value_definition@16:8");
    // No comments, no strings, no `obj.foo` property access, no class methods.
    for (const occ of occurrences) {
      expect(occ.line).not.toBe(1);
      expect(occ.line).not.toBe(2);
      expect(occ.line).not.toBe(3);
      expect(occ.line).not.toBe(4);
      expect(occ.line).not.toBe(10);
      expect(occ.line).not.toBe(11);
    }
  });

  test("AST-walk treats assignment LHS and increment/decrement targets as value_write", () => {
    clearParsedSourceCache();
    const parsed = parseSource("writes.ts", `let x = 0;\nx = 1;\nx += 2;\nx++;\n++x;\n`);
    const occurrences = findOccurrences(parsed, "x", { mode: "ast-walk" });
    const tags = occurrences.map((o) => `${o.kind}@${o.line}:${o.column}`).toSorted();
    expect(tags).toContain("value_definition@1:4");
    expect(tags).toContain("value_write@2:0");
    expect(tags).toContain("value_write@3:0");
    expect(tags).toContain("value_write@4:0");
    expect(tags).toContain("value_write@5:2");
    expect(tags.filter((t) => t.startsWith("value_reference@"))).toHaveLength(0);
  });

  test("findOccurrences returns empty array for invalid identifier names", () => {
    const parsed = parseSource("a.ts", `const x = 1;`);
    expect(findOccurrences(parsed, "1abc")).toHaveLength(0);
    expect(findOccurrences(parsed, "")).toHaveLength(0);
  });
});

describe("parsing/oxc-source: applySourceEdits + renameInFile", () => {
  test("applySourceEdits performs non-overlapping replacements without shifting offsets", () => {
    const text = "abcdefghij";
    const edits = [
      { start: 0, end: 1, replacement: "AA" },
      { start: 4, end: 6, replacement: "" },
      { start: 8, end: 10, replacement: "ZZZZ" },
    ];
    expect(applySourceEdits(text, edits)).toBe("AAbcdghZZZZ");
  });

  test("renameInFile rewrites only scope-anchored positions and preserves trivia", () => {
    clearParsedSourceCache();
    const parsed = parseSource("foo.ts", COMMENT_AND_STRING_AWARE_SOURCE);
    const fnDecl = findIdentifierAtPosition(parsed, 5, 9);
    expect(fnDecl?.name).toBe("foo");
    const occurrences = findOccurrences(parsed, "foo", { atOffset: fnDecl!.start });
    expect(occurrences.length).toBeGreaterThan(0);
    const result = renameInFile(parsed, occurrences, "renamedFoo");

    // Comments + strings preserved verbatim.
    expect(result.sourceText).toContain("// rename foo here? no");
    expect(result.sourceText).toContain("/* foo also lives in a block comment */");
    expect(result.sourceText).toContain('"foo lives in this string literal"');
    expect(result.sourceText).toContain("`foo lives in template too`");
    // Property names + class members untouched.
    expect(result.sourceText).toContain("{ foo: 1, bar: renamedFoo, ['foo']: 9 }");
    expect(result.sourceText).toContain("class Widget {");
    expect(result.sourceText).toContain("foo() { return 0; }");
    expect(result.sourceText).toContain("static foo = 1;");
    // Inner shadowed `foo` (different binding) not touched.
    expect(result.sourceText).toContain('const foo = "shadow"');
    expect(result.sourceText).toContain("return foo;");
    // Function declaration + body references rewritten.
    expect(result.sourceText).toContain("function renamedFoo()");
    expect(result.sourceText).toContain("return renamedFoo() + renamedFoo.length;");
  });

  test("renameInFile returns sourceText unchanged when no occurrences", () => {
    const parsed = parseSource("none.ts", `const x = 1;`);
    const result = renameInFile(parsed, [], "y");
    expect(result.sourceText).toBe(parsed.sourceText);
    expect(result.occurrences).toHaveLength(0);
  });

  test("renameInFile throws on invalid identifier names", () => {
    const parsed = parseSource("a.ts", `function foo() {}`);
    const occurrences = findOccurrences(parsed, "foo");
    expect(() => renameInFile(parsed, occurrences, "1bad")).toThrow();
  });
});

describe("parsing/oxc-source: helper invariants", () => {
  test("formatSymbolLine yields location:line:col -> kind name", () => {
    const parsed = parseSource("fmt.ts", `function widget() { return 1; }`);
    const symbol = collectSymbols(parsed, { limit: 1 })[0];
    expect(symbol).toBeDefined();
    expect(formatSymbolLine("file.ts", symbol!)).toMatch(/^file\.ts:\d+:\d+ -> function widget$/);
  });

  test("isValidIdentifierName accepts identifiers and rejects keywords-shaped junk", () => {
    expect(isValidIdentifierName("foo")).toBe(true);
    expect(isValidIdentifierName("_foo$1")).toBe(true);
    expect(isValidIdentifierName("$foo")).toBe(true);
    expect(isValidIdentifierName("1foo")).toBe(false);
    expect(isValidIdentifierName("foo bar")).toBe(false);
    expect(isValidIdentifierName("")).toBe(false);
  });

  test("walkAst types: AstNode is a discriminated by `type`", () => {
    const parsed = parseSource("walk-types.ts", `const x = 1;`);
    walkAst(parsed.program, ({ node }) => {
      const n: AstNode = node;
      expect(typeof n.type).toBe("string");
      expect(typeof n.start).toBe("number");
      expect(typeof n.end).toBe("number");
    });
  });
});

function oxcSyntheticError(
  severity: "Error" | "Warning" | "Advice",
  message: string,
  spans: readonly { readonly start: number; readonly end: number }[],
): OxcError {
  return {
    severity: severity as OxcError["severity"],
    message,
    labels: spans.map((s) => ({ message: null, start: s.start, end: s.end })),
    helpMessage: null,
    codeframe: null,
  };
}

describe("parsing/oxc-source: diffIntroducedFatalParseErrors", () => {
  test("only compares Error multiset; ignores Warning/Advice noise", () => {
    const before = [
      oxcSyntheticError("Warning", "noise", [{ start: 1, end: 2 }]),
      oxcSyntheticError("Error", "real", [{ start: 10, end: 12 }]),
    ];
    const after = [
      ...before,
      oxcSyntheticError("Warning", "new warning should not abort rename", [{ start: 3, end: 4 }]),
      oxcSyntheticError("Error", "new fatal", [{ start: 99, end: 100 }]),
    ];
    const delta = diffIntroducedFatalParseErrors(before, after);
    expect(delta).toHaveLength(1);
    expect(delta[0]!.message).toBe("new fatal");
  });

  test("matches duplicates by message + label spans (multiset)", () => {
    const a = oxcSyntheticError("Error", "dup", [{ start: 1, end: 2 }]);
    expect(diffIntroducedFatalParseErrors([a], [a, a])).toHaveLength(1);
    expect(diffIntroducedFatalParseErrors([a, a], [a, a])).toHaveLength(0);
  });
});
