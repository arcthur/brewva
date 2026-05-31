import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBrewvaTools } from "@brewva/brewva-tools";
import {
  createLspTools,
  createSourcePatchTools,
  shutdownLspWorkspaceServerManager,
} from "@brewva/brewva-tools/navigation";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";
import { toolOutcomePayload } from "../../helpers/tool-outcome.js";
import { extractTextContent, fakeContext } from "./tools-flow.helpers.js";

function names(tools: Array<{ name: string }>): string[] {
  return tools.map((tool) => tool.name).toSorted();
}

describe("real LSP tool surface", () => {
  afterEach(async () => {
    await shutdownLspWorkspaceServerManager();
  });

  test("default bundle removes pseudo LSP and direct-write AST tools", () => {
    const runtime = { extensions: { tools: {} } } as Parameters<
      typeof buildBrewvaTools
    >[0]["runtime"];
    const toolNames = names(buildBrewvaTools({ runtime }));

    expect(toolNames).toContain("source_read");
    expect(toolNames).toContain("source_patch_prepare");
    expect(toolNames).toContain("source_patch_apply");
    expect(toolNames).toContain("resource_read");
    expect(toolNames).toContain("lsp_status");
    expect(toolNames).toContain("lsp_definition");
    expect(toolNames).toContain("lsp_references");
    expect(toolNames).toContain("lsp_rename");
    expect(toolNames).not.toContain("read_spans");
    expect(toolNames).not.toContain("lsp_goto_definition");
    expect(toolNames).not.toContain("lsp_find_references");
    expect(toolNames).not.toContain("ast_prepare_rename");
    expect(toolNames).not.toContain("ast_rename_in_file");
    expect(toolNames).not.toContain("ast_grep_replace");
    expect(toolNames).not.toContain("ast_grep_search");
  });

  test("LSP tools expose real language-server names", () => {
    const tools = createLspTools();

    expect(names(tools)).toEqual([
      "lsp_code_action",
      "lsp_definition",
      "lsp_diagnostics",
      "lsp_file_rename",
      "lsp_format",
      "lsp_hover",
      "lsp_implementation",
      "lsp_references",
      "lsp_rename",
      "lsp_status",
      "lsp_type_definition",
    ]);
  });

  test("LSP tools reuse one server process for repeated workspace calls", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-lsp-manager-"));
    const sourcePath = join(workspace, "example.ts");
    const serverPath = join(workspace, "fixture-lsp.js");
    const initCountPath = join(workspace, "init-count.txt");
    const changeCountPath = join(workspace, "change-count.txt");
    const configDir = join(workspace, ".brewva");
    mkdirSync(configDir);
    writeFileSync(sourcePath, "export const value = 1;\n", "utf8");
    writeFileSync(
      serverPath,
      `
const fs = require("node:fs");
let buffer = Buffer.alloc(0);

function write(message) {
  const body = JSON.stringify(message);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
}

function handle(message) {
  if (message.method === "initialize") {
    fs.appendFileSync(${JSON.stringify(initCountPath)}, "1\\n");
    write({ jsonrpc: "2.0", id: message.id, result: { capabilities: { hoverProvider: true } } });
    return;
  }
  if (message.method === "textDocument/didChange") {
    fs.appendFileSync(${JSON.stringify(changeCountPath)}, "1\\n");
    return;
  }
  if (message.method === "shutdown") {
    write({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "textDocument/hover") {
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: { contents: { kind: "plaintext", value: "hover" } }
    });
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) break;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /Content-Length:\\s*(\\d+)/i.exec(header);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) break;
    const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.subarray(bodyEnd);
    handle(JSON.parse(body));
  }
});
`,
      "utf8",
    );
    writeFileSync(
      join(configDir, "lsp.json"),
      `${JSON.stringify({ command: process.execPath, args: [serverPath] }, null, 2)}\n`,
      "utf8",
    );
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
    const hover = createLspTools({ runtime }).find((tool) => tool.name === "lsp_hover");
    if (!hover) {
      throw new Error("Missing lsp_hover tool.");
    }

    const firstResult = await hover.execute(
      "tc-lsp-manager-1",
      { uri: "example.ts", line: 0, character: 13 },
      undefined,
      undefined,
      fakeContext("tc-lsp-manager"),
    );
    expect(
      extractTextContent(firstResult as { content: Array<{ type: string; text?: string }> }),
    ).toContain("status: ok");

    writeFileSync(sourcePath, "export const value = 2;\n", "utf8");

    const secondResult = await hover.execute(
      "tc-lsp-manager-2",
      { uri: "example.ts", line: 0, character: 13 },
      undefined,
      undefined,
      fakeContext("tc-lsp-manager"),
    );
    expect(
      extractTextContent(secondResult as { content: Array<{ type: string; text?: string }> }),
    ).toContain("status: ok");

    expect(readFileSync(initCountPath, "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(changeCountPath, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("lsp_rename uses a real JSON-RPC server and returns a SourcePatchPlan", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-lsp-fixture-"));
    const sourcePath = join(workspace, "example.ts");
    const serverPath = join(workspace, "fixture-lsp.js");
    const configDir = join(workspace, ".brewva");
    mkdirSync(configDir);
    writeFileSync(sourcePath, "export const oldName = 1;\nconsole.log(oldName);\n", "utf8");
    writeFileSync(
      serverPath,
      `
const chunks = [];
let buffer = Buffer.alloc(0);

function write(message) {
  const body = JSON.stringify(message);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
}

function handle(message) {
  if (message.method === "initialize") {
    write({ jsonrpc: "2.0", id: message.id, result: { capabilities: { renameProvider: true } } });
    return;
  }
  if (message.method === "shutdown") {
    write({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "textDocument/rename") {
    const uri = message.params.textDocument.uri;
    const newName = message.params.newName;
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        changes: {
          [uri]: [
            { range: { start: { line: 0, character: 13 }, end: { line: 0, character: 20 } }, newText: newName },
            { range: { start: { line: 1, character: 12 }, end: { line: 1, character: 19 } }, newText: newName }
          ]
        }
      }
    });
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) break;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /Content-Length:\\s*(\\d+)/i.exec(header);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) break;
    const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.subarray(bodyEnd);
    handle(JSON.parse(body));
  }
});
`,
      "utf8",
    );
    writeFileSync(
      join(configDir, "lsp.json"),
      `${JSON.stringify({ command: process.execPath, args: [serverPath] }, null, 2)}\n`,
      "utf8",
    );
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
    const rename = createLspTools({ runtime }).find((tool) => tool.name === "lsp_rename");
    if (!rename) {
      throw new Error("Missing lsp_rename tool.");
    }
    const result = await rename.execute(
      "tc-lsp-rename",
      { uri: "example.ts", line: 0, character: 14, new_name: "newName" },
      undefined,
      undefined,
      fakeContext("tc-lsp-rename"),
    );
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    const planId = (toolOutcomePayload(result) as { planId?: string }).planId;
    expect(text).toContain("status: prepared");
    expect(planId).toMatch(/^plan_/u);
    expect(readFileSync(sourcePath, "utf8")).toContain("oldName");

    const [, apply] = createSourcePatchTools({ runtime });
    await apply.execute(
      "tc-lsp-rename-apply",
      { plan_id: planId },
      undefined,
      undefined,
      fakeContext("tc-lsp-rename"),
    );
    expect(readFileSync(sourcePath, "utf8")).toContain("newName");
    expect(readFileSync(sourcePath, "utf8")).not.toContain("oldName");
  });

  test("lsp_code_action merges create resource operations with text edits", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-lsp-code-action-"));
    const sourcePath = join(workspace, "example.ts");
    const helperPath = join(workspace, "helper.ts");
    const serverPath = join(workspace, "fixture-lsp.js");
    const configDir = join(workspace, ".brewva");
    mkdirSync(configDir);
    writeFileSync(sourcePath, "export {};\n", "utf8");
    writeFileSync(
      serverPath,
      `
let buffer = Buffer.alloc(0);

function write(message) {
  const body = JSON.stringify(message);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
}

function handle(message) {
  if (message.method === "initialize") {
    write({ jsonrpc: "2.0", id: message.id, result: { capabilities: { codeActionProvider: true } } });
    return;
  }
  if (message.method === "shutdown") {
    write({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "textDocument/codeAction") {
    const uri = message.params.textDocument.uri;
    const helperUri = uri.replace(/example\\.ts$/, "helper.ts");
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: [
        {
          title: "Create helper",
          edit: {
            documentChanges: [
              { kind: "create", uri: helperUri },
              {
                textDocument: { uri: helperUri, version: null },
                edits: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    newText: "export const helper = 1;\\n"
                  }
                ]
              }
            ]
          }
        }
      ]
    });
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) break;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /Content-Length:\\s*(\\d+)/i.exec(header);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) break;
    const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.subarray(bodyEnd);
    handle(JSON.parse(body));
  }
});
`,
      "utf8",
    );
    writeFileSync(
      join(configDir, "lsp.json"),
      `${JSON.stringify({ command: process.execPath, args: [serverPath] }, null, 2)}\n`,
      "utf8",
    );
    const runtime = createRuntimeInstanceFixture({ cwd: workspace });
    const codeAction = createLspTools({ runtime }).find((tool) => tool.name === "lsp_code_action");
    if (!codeAction) {
      throw new Error("Missing lsp_code_action tool.");
    }

    const result = await codeAction.execute(
      "tc-lsp-code-action",
      {
        uri: "example.ts",
        start_line: 0,
        start_character: 0,
        end_line: 0,
        end_character: 0,
        action_index: 0,
      },
      undefined,
      undefined,
      fakeContext("tc-lsp-code-action"),
    );
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    const planId = (toolOutcomePayload(result) as { planId?: string }).planId;
    expect(text).toContain("status: prepared");
    expect(planId).toMatch(/^plan_/u);
    expect(existsSync(helperPath)).toBe(false);

    const [, apply] = createSourcePatchTools({ runtime });
    await apply.execute(
      "tc-lsp-code-action-apply",
      { plan_id: planId },
      undefined,
      undefined,
      fakeContext("tc-lsp-code-action"),
    );
    expect(readFileSync(helperPath, "utf8")).toBe("export const helper = 1;\n");
  });
});
