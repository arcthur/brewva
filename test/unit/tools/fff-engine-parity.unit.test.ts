import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  disposeFinders,
  FffEngine,
  type GrepEngineRequest,
  isFffAvailable,
  RipgrepEngine,
} from "../../../packages/brewva-tools/src/families/navigation/grep/engine/index.js";

// Cases here do real end-to-end work (subprocess spawns, source-tree scans, embedded
// runtimes) that can exceed bun's 5s default test timeout under machine load (bare
// `bun test`; package scripts pass --timeout 600000).
setDefaultTimeout(60_000);

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "brewva-fff-parity-"));
  writeFileSync(
    join(dir, "alpha.ts"),
    [
      "export function createWidget() { return 1; }",
      "const widget = createWidget();",
      "// TODO: refactor createWidget later",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(dir, "beta.ts"),
    ["import { createWidget } from './alpha';", "export const Widget = createWidget;"].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(dir, "notes.md"),
    ["createWidget is documented here", "Nothing else matches"].join("\n"),
    "utf8",
  );
  mkdirSync(join(dir, "sub"));
  writeFileSync(
    join(dir, "sub", "gamma.ts"),
    ["function helper() {}", "createWidget();"].join("\n"),
    "utf8",
  );
  return dir;
}

function normalize(lines: string[]): string[] {
  return lines.map((line) => line.replace(/^\.\//u, "")).toSorted();
}

function baseRequest(cwd: string, overrides: Partial<GrepEngineRequest>): GrepEngineRequest {
  return {
    cwd,
    query: "createWidget",
    paths: ["."],
    globs: [],
    caseMode: "smart",
    fixed: false,
    forceIgnoreCase: false,
    maxLines: 200,
    timeoutMs: 30_000,
    signal: null,
    ...overrides,
  };
}

describe("fff/ripgrep grep parity", () => {
  afterAll(async () => {
    await disposeFinders();
  });

  test("fff is available in this runtime (else parity is meaningless)", async () => {
    expect(await isFffAvailable()).toBe(true);
  });

  test("whole-tree literal smart-case query matches ripgrep locations", async () => {
    const ws = makeWorkspace();
    const ripgrep = new RipgrepEngine();
    const fff = new FffEngine(new RipgrepEngine());
    const req = baseRequest(ws, { query: "createWidget", fixed: true });
    const [rg, ff] = await Promise.all([ripgrep.grep(req), fff.grep(req)]);
    expect(ff.exitCode).toBe(rg.exitCode);
    expect(normalize(ff.lines)).toEqual(normalize(rg.lines));
  });

  test("whole-tree regex query matches ripgrep locations", async () => {
    const ws = makeWorkspace();
    const ripgrep = new RipgrepEngine();
    const fff = new FffEngine(new RipgrepEngine());
    const req = baseRequest(ws, { query: "create\\w+", fixed: false });
    const [rg, ff] = await Promise.all([ripgrep.grep(req), fff.grep(req)]);
    expect(ff.exitCode).toBe(rg.exitCode);
    expect(normalize(ff.lines)).toEqual(normalize(rg.lines));
  });

  test("no-match returns exitCode 1 like ripgrep", async () => {
    const ws = makeWorkspace();
    const ripgrep = new RipgrepEngine();
    const fff = new FffEngine(new RipgrepEngine());
    const req = baseRequest(ws, { query: "this_identifier_does_not_exist", fixed: true });
    const [rg, ff] = await Promise.all([ripgrep.grep(req), fff.grep(req)]);
    expect(ff.exitCode).toBe(rg.exitCode);
    expect(ff.lines).toHaveLength(0);
  });

  test("scoped paths delegate to ripgrep (outside fff index scope)", async () => {
    const ws = makeWorkspace();
    const ripgrep = new RipgrepEngine();
    const fff = new FffEngine(new RipgrepEngine());
    const req = baseRequest(ws, { query: "createWidget", paths: ["sub"], fixed: true });
    const [rg, ff] = await Promise.all([ripgrep.grep(req), fff.grep(req)]);
    expect(normalize(ff.lines)).toEqual(normalize(rg.lines));
  });

  test("globbed grep delegates to ripgrep", async () => {
    const ws = makeWorkspace();
    const ripgrep = new RipgrepEngine();
    const fff = new FffEngine(new RipgrepEngine());
    const req = baseRequest(ws, { query: "createWidget", globs: ["*.md"], fixed: true });
    const [rg, ff] = await Promise.all([ripgrep.grep(req), fff.grep(req)]);
    expect(normalize(ff.lines)).toEqual(normalize(rg.lines));
  });
});
