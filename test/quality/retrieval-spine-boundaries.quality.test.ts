import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

function listFiles(root: string): string[] {
  const absoluteRoot = resolve(repoRoot, root);
  if (!existsSync(absoluteRoot)) return [];
  const pending = [absoluteRoot];
  const files: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        if (entry === "node_modules" || entry === "dist" || entry === ".tmp") continue;
        pending.push(path);
        continue;
      }
      if (stats.isFile() && /\.(?:ts|tsx|js)$/u.test(entry)) {
        files.push(relative(repoRoot, path));
      }
    }
  }
  return files;
}

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

describe("retrieval spine package boundaries", () => {
  test("keeps jieba and compound-token options private to brewva-search", () => {
    const files = listFiles("packages").filter((file) => !file.includes("/dist/"));
    const externalJiebaImports = files.filter(
      (file) =>
        !file.startsWith("packages/brewva-search/src/") &&
        readRepoFile(file).includes("jieba-wasm"),
    );
    const externalCompoundOptions = files.filter(
      (file) =>
        !file.startsWith("packages/brewva-search/src/") &&
        readRepoFile(file).includes("includeCompoundSubtokens"),
    );
    const externalRawTokenizerCalls = files.filter(
      (file) =>
        !file.startsWith("packages/brewva-search/src/tokenization/") &&
        readRepoFile(file).includes("tokenizeSearchText"),
    );

    expect(externalJiebaImports).toEqual([]);
    expect(externalCompoundOptions).toEqual([]);
    expect(externalRawTokenizerCalls).toEqual([]);
  });

  test("keeps recall root curated and implementation surfaces on explicit subpaths", () => {
    const root = readRepoFile("packages/brewva-recall/src/index.ts");
    expect(root).not.toContain("export *");

    for (const removedPath of [
      "packages/brewva-recall/src/broker.ts",
      "packages/brewva-recall/src/context-provider.ts",
      "packages/brewva-recall/src/knowledge-search-core.ts",
      "packages/brewva-recall/src/evidence-events.ts",
      "packages/brewva-recall/src/session-digests.ts",
    ]) {
      expect(existsSync(resolve(repoRoot, removedPath))).toBe(false);
    }

    for (const file of listFiles("packages").filter(
      (entry) => entry.startsWith("packages/") && !entry.startsWith("packages/brewva-recall/"),
    )) {
      const source = readRepoFile(file);
      expect(source).not.toMatch(
        /from\s+["']@brewva\/brewva-recall["'][^;]*(?:getOrCreateRecallBroker|createRecallContextProvider|executeKnowledgeSearch|findKnowledgeDocByRelativePath)/u,
      );
    }
  });

  test("keeps session-index as the only indexed tape event allowlist owner", () => {
    const recallFiles = listFiles("packages/brewva-recall/src");
    for (const file of recallFiles) {
      const source = readRepoFile(file);
      expect(source).not.toContain("RECALL_SEARCHABLE_TAPE_EVENT_TYPES");
      expect(source).not.toContain("isRecallSearchableTapeEvent");
    }

    const sessionIndexRoot = readRepoFile("packages/brewva-session-index/src/index.ts");
    const sessionIndexPublic = readRepoFile("packages/brewva-session-index/src/public/index.ts");
    expect(sessionIndexRoot).not.toContain("DuckDBSessionIndex");
    expect(sessionIndexRoot).not.toContain("export *");
    expect(sessionIndexPublic).not.toMatch(/type\s+\{[\s\S]*from\s+["']\.\.\/factory\.js["']/u);
  });
});
