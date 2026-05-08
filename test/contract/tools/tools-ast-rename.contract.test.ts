import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLspTools } from "@brewva/brewva-tools/navigation";
import { requireDefined } from "../../helpers/assertions.js";
import {
  createBundledToolRuntime,
  createRuntime,
  extractTextContent,
  fakeContext,
} from "./tools-parallel-read.helpers.js";

function workspaceWithRenameSample(prefix: string): string {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(
    join(workspace, "src/widget.ts"),
    [
      "// rename foo here? no",
      "/* foo also lives in a block comment */",
      'const message = "foo lives in this string literal";',
      "function foo() {",
      "  return foo() + foo.length;",
      "}",
      "const obj = { foo: 1, bar: foo, ['foo']: 9 };",
      "class Widget {",
      "  foo() { return 0; }",
      "  static foo = 1;",
      "}",
      "function shadowed() {",
      '  const foo = "shadow";',
      "  return foo;",
      "}",
      "export { foo };",
      "",
    ].join("\n"),
    "utf8",
  );
  return workspace;
}

function requireTool<T extends { name: string }>(tools: T[], name: string): T {
  return requireDefined(
    tools.find((tool) => tool.name === name),
    `Expected tool ${name}.`,
  );
}

describe("ast_prepare_rename + ast_rename_in_file (single-file scope-aware rename)", () => {
  test("ast_prepare_rename reports scoped occurrences and skips comments/strings/properties", async () => {
    const workspace = workspaceWithRenameSample("brewva-tools-ast-prepare-");
    const runtime = createRuntime(workspace);
    const sessionId = "tc-ast-prepare-rename-scoped";
    const tools = createLspTools({ runtime: createBundledToolRuntime(runtime) });
    const astPrepareRename = requireTool(tools, "ast_prepare_rename");

    const filePath = join(workspace, "src/widget.ts");
    // Cursor on `function foo()` declaration: line 4, char 9 ("function " is 9 chars).
    const result = await astPrepareRename.execute(
      "tc-ast-prepare-rename-scoped-1",
      { filePath, line: 4, character: 9 },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });

    // Expected occurrences (line:column):
    //   4:9  -> function foo declaration (value_definition)
    //   5:9  -> first foo() call (value_reference)
    //   5:17 -> foo.length (value_reference)
    //   7:27 -> bar: foo (value_reference)
    //  16:9  -> export { foo } -- the exported identifier resolves to the same
    //                            module-level binding (value_reference).
    expect(text).toContain(`${filePath}:4:9`);
    expect(text).toContain(`${filePath}:5:9`);
    expect(text).toContain(`${filePath}:5:17`);
    expect(text).toContain(`${filePath}:7:27`);

    // Comments + strings + property keys + class members + the inner shadowed
    // `foo` MUST NOT appear.
    expect(text).not.toContain(`${filePath}:1:`); // // rename foo here
    expect(text).not.toContain(`${filePath}:2:`); // /* block comment */
    expect(text).not.toContain(`${filePath}:3:`); // string literal
    expect(text).not.toContain(`${filePath}:9:`); // class method foo
    expect(text).not.toContain(`${filePath}:10:`); // static foo = 1
    expect(text).not.toContain(`${filePath}:13:`); // const foo = "shadow"
    expect(text).not.toContain(`${filePath}:14:`); // return foo (inner scope)
  });

  test("ast_prepare_rename returns inconclusive when cursor is not on an identifier", async () => {
    const workspace = workspaceWithRenameSample("brewva-tools-ast-prepare-empty-");
    const runtime = createRuntime(workspace);
    const tools = createLspTools({ runtime: createBundledToolRuntime(runtime) });
    const astPrepareRename = requireTool(tools, "ast_prepare_rename");

    const filePath = join(workspace, "src/widget.ts");
    // Line 1 is a comment; cursor at column 50 (well past EOL) -> no identifier.
    const result = await astPrepareRename.execute(
      "tc-ast-prepare-rename-empty",
      { filePath, line: 1, character: 50 },
      undefined,
      undefined,
      fakeContext("tc-ast-prepare-rename-empty", workspace),
    );
    expect(
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }),
    ).toContain("not on an identifier");
  });

  test("ast_rename_in_file rewrites only AST-resolved positions on disk", async () => {
    const workspace = workspaceWithRenameSample("brewva-tools-ast-rename-");
    const runtime = createRuntime(workspace);
    const tools = createLspTools({ runtime: createBundledToolRuntime(runtime) });
    const astRenameInFile = requireTool(tools, "ast_rename_in_file");

    const filePath = join(workspace, "src/widget.ts");
    const before = readFileSync(filePath, "utf8");
    const result = await astRenameInFile.execute(
      "tc-ast-rename",
      { filePath, line: 4, character: 9, newName: "renamedFoo" },
      undefined,
      undefined,
      fakeContext("tc-ast-rename", workspace),
    );
    expect(
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }),
    ).toContain("Renamed 'foo' to 'renamedFoo'");

    const after = readFileSync(filePath, "utf8");
    expect(after).not.toBe(before);

    // Comments, strings, properties, class members, inner shadow preserved.
    expect(after).toContain("// rename foo here? no");
    expect(after).toContain("/* foo also lives in a block comment */");
    expect(after).toContain('"foo lives in this string literal"');
    expect(after).toContain("{ foo: 1, bar: renamedFoo, ['foo']: 9 }");
    expect(after).toContain("foo() { return 0; }");
    expect(after).toContain("static foo = 1;");
    expect(after).toContain('const foo = "shadow"');
    // The function declaration + body refs were rewritten.
    expect(after).toContain("function renamedFoo()");
    expect(after).toContain("return renamedFoo() + renamedFoo.length;");
    expect(after).toContain("export { renamedFoo };");
  });

  test("ast_rename_in_file rejects invalid newName", async () => {
    const workspace = workspaceWithRenameSample("brewva-tools-ast-rename-bad-");
    const runtime = createRuntime(workspace);
    const tools = createLspTools({ runtime: createBundledToolRuntime(runtime) });
    const astRenameInFile = requireTool(tools, "ast_rename_in_file");

    const filePath = join(workspace, "src/widget.ts");
    const result = await astRenameInFile.execute(
      "tc-ast-rename-bad",
      { filePath, line: 4, character: 9, newName: "1bad name" },
      undefined,
      undefined,
      fakeContext("tc-ast-rename-bad", workspace),
    );
    expect(
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }),
    ).toContain("newName must be a valid identifier");
  });

  test("ast_rename_in_file refuses to mutate non-TS/JS files", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-ast-rename-py-"));
    writeFileSync(join(workspace, "thing.py"), "def foo():\n    return foo()\n", "utf8");
    const runtime = createRuntime(workspace);
    const tools = createLspTools({ runtime: createBundledToolRuntime(runtime) });
    const astRenameInFile = requireTool(tools, "ast_rename_in_file");

    const result = await astRenameInFile.execute(
      "tc-ast-rename-py",
      { filePath: join(workspace, "thing.py"), line: 1, character: 4, newName: "bar" },
      undefined,
      undefined,
      fakeContext("tc-ast-rename-py", workspace),
    );
    expect(
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }),
    ).toContain("only supports");
  });

  test("ast_rename_in_file noops when newName matches current name", async () => {
    const workspace = workspaceWithRenameSample("brewva-tools-ast-rename-noop-");
    const runtime = createRuntime(workspace);
    const tools = createLspTools({ runtime: createBundledToolRuntime(runtime) });
    const astRenameInFile = requireTool(tools, "ast_rename_in_file");

    const filePath = join(workspace, "src/widget.ts");
    const before = readFileSync(filePath, "utf8");
    const result = await astRenameInFile.execute(
      "tc-ast-rename-noop",
      { filePath, line: 4, character: 9, newName: "foo" },
      undefined,
      undefined,
      fakeContext("tc-ast-rename-noop", workspace),
    );
    expect(
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }),
    ).toContain("already named");
    expect(readFileSync(filePath, "utf8")).toBe(before);
  });
});
