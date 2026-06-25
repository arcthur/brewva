import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// The session index is a rebuildable READ MODEL over the canonical event tape: it
// projects events into a queryable SQLite + FTS5 plane and never feeds replay or
// authority. These guards keep that posture standing — the package must not reach
// into runtime tape/kernel/authority writers, must not expose tree-history
// parentId or any tape-mutation verb, and must stay reachable only as a
// query/projection surface (its only @brewva dependencies are the search
// tokenizer, std utilities, and read-only vocabulary contracts).

const repoRoot = resolve(import.meta.dir, "../..");
const packageSrc = "packages/brewva-session-index/src";

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function listSourceFiles(relativeRoot: string): string[] {
  const absoluteRoot = resolve(repoRoot, relativeRoot);
  if (!existsSync(absoluteRoot)) return [];
  const pending = [absoluteRoot];
  const files: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".tmp") continue;
      const path = join(current, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (stats.isFile() && /\.(?:ts|tsx)$/u.test(entry)) {
        files.push(relative(repoRoot, path));
      }
    }
  }
  return files;
}

function brewvaImportSpecifiers(source: string): string[] {
  return [...source.matchAll(/from\s+["'](@brewva\/[^"']+)["']/gu)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  );
}

// The packages that own the canonical tape, kernel, and authority writers. A read
// model that imported any of these would couple itself to truth-mutating surfaces.
const FORBIDDEN_WRITER_PACKAGE_PREFIXES = [
  "@brewva/brewva-runtime",
  "@brewva/brewva-gateway",
] as const;

// The only @brewva package roots a pure projection surface may depend on: the
// search tokenizer, shared std utilities, and read-only vocabulary contracts.
const ALLOWED_BREWVA_PACKAGE_ROOTS = new Set([
  "@brewva/brewva-search",
  "@brewva/brewva-std",
  "@brewva/brewva-vocabulary",
]);

function packageRootOf(specifier: string): string {
  const segments = specifier.split("/");
  return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : specifier;
}

describe("session index read-model discipline", () => {
  test("source never imports runtime tape/kernel/authority writer packages", () => {
    const offenders = listSourceFiles(packageSrc).flatMap((file) => {
      const specifiers = brewvaImportSpecifiers(readRepoFile(file));
      return specifiers
        .filter((specifier) =>
          FORBIDDEN_WRITER_PACKAGE_PREFIXES.some(
            (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`),
          ),
        )
        .map((specifier) => `${file} -> ${specifier}`);
    });

    expect(offenders).toEqual([]);
  });

  test("@brewva dependencies stay confined to the read/projection surface", () => {
    const offenders = listSourceFiles(packageSrc).flatMap((file) => {
      const roots = brewvaImportSpecifiers(readRepoFile(file)).map(packageRootOf);
      return roots
        .filter((root) => !ALLOWED_BREWVA_PACKAGE_ROOTS.has(root))
        .map((root) => `${file} -> ${root}`);
    });

    expect(offenders).toEqual([]);
  });

  test("read model exposes no tree-history parentId surface", () => {
    const offenders = listSourceFiles(packageSrc).filter((file) =>
      /\bparentId\b/u.test(readRepoFile(file)),
    );

    expect(offenders).toEqual([]);
  });

  test("public API and engine expose query/projection verbs, not tape mutation", () => {
    // The read model mutates only its OWN derived index (catchUp / rebuild). It must
    // never expose a verb that writes the canonical tape — appending, committing, or
    // otherwise mutating source events is the authority writer's job alone.
    const tapeMutationPattern =
      /\b(?:append|write|commit|persist|delete|mutate|record|emit)[A-Za-z]*(?:Tape|Event|Canonical)[A-Za-z]*\s*[(:]/u;
    const surfaceFiles = [
      `${packageSrc}/api.ts`,
      `${packageSrc}/index.ts`,
      `${packageSrc}/public/index.ts`,
      `${packageSrc}/factory.ts`,
    ];
    const offenders = surfaceFiles.flatMap((file) => {
      const source = readRepoFile(file);
      const matches = [...source.matchAll(new RegExp(tapeMutationPattern, "gu"))].map(
        (match) => `${file}: ${match[0]}`,
      );
      return matches;
    });

    expect(offenders).toEqual([]);
  });

  test("read model is consumed only as a query/projection import, never re-exported as a writer", () => {
    // No production package may pull a tape-WRITING helper out of session-index: it
    // surfaces createSessionIndex (a query handle) and pure project*/cluster* helpers
    // only. This pins the projection-only contract at the consumer boundary too.
    const forbiddenReexport =
      /from\s+["']@brewva\/brewva-session-index(?:\/[^"']+)?["'][^;]*(?:appendTape|writeTape|commitTape|mutateTape|recordEvent)/u;
    const offenders = listSourceFiles("packages")
      .filter((file) => !file.startsWith(`${packageSrc}/`) && !file.includes("/dist/"))
      .filter((file) => forbiddenReexport.test(readRepoFile(file)));

    expect(offenders).toEqual([]);
  });
});
