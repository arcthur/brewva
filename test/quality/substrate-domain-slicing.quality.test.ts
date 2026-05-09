import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const substrateRoot = join(repoRoot, "packages", "brewva-substrate");
const substrateSrc = join(substrateRoot, "src");

function listTsFiles(root: string): string[] {
  const entries = (() => {
    try {
      return readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  })();
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(root, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      files.push(...listTsFiles(path));
      continue;
    }

    if (entry.isFile() && (path.endsWith(".ts") || path.endsWith(".tsx"))) {
      files.push(path);
    }
  }

  return files;
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("substrate domain slicing quality guard", () => {
  test("keeps the substrate root source entrypoint as a thin public stub", () => {
    const source = read(join(substrateSrc, "index.ts")).trim();

    expect(source).toBe('export * from "./public/index.js";');
  });

  test("keeps public and domain api files explicit", () => {
    const apiFiles = [
      join(substrateSrc, "public", "index.ts"),
      join(substrateSrc, "contracts", "api.ts"),
      join(substrateSrc, "session", "api.ts"),
      join(substrateSrc, "prompt", "api.ts"),
      join(substrateSrc, "resources", "api.ts"),
      join(substrateSrc, "provenance", "api.ts"),
      join(substrateSrc, "execution", "api.ts"),
      join(substrateSrc, "compaction", "api.ts"),
      join(substrateSrc, "tools", "api.ts"),
      join(substrateSrc, "host-api", "api.ts"),
      join(substrateSrc, "persistence", "api.ts"),
      join(substrateSrc, "provider", "api.ts"),
      join(substrateSrc, "sdk", "api.ts"),
    ];

    for (const apiFile of apiFiles) {
      expect(read(apiFile), relative(repoRoot, apiFile)).not.toMatch(/^\s*export\s+\*/m);
    }
  });

  test("does not keep old source-path shims for moved substrate implementation files", () => {
    const removedPaths = [
      "session/prompt-content.ts",
      "session/prompt-templates.ts",
      "session/system-prompt.ts",
      "session/markdown-frontmatter.ts",
      "session/resource-loader.ts",
      "session/skill-discovery.ts",
      "tools/edit-diff.ts",
      "tools/file-mutation-queue.ts",
      "tools/mime.ts",
      "tools/path-utils.ts",
      "tools/render.ts",
      "tools/truncate.ts",
    ];

    for (const removedPath of removedPaths) {
      expect(existsSync(join(substrateSrc, removedPath)), removedPath).toBe(false);
    }
  });

  test("keeps internal substrate helpers out of package exports", () => {
    const packageJson = JSON.parse(read(join(substrateRoot, "package.json"))) as {
      exports: Record<string, unknown>;
    };

    expect(packageJson.exports).not.toHaveProperty("./tools/_shared");
    expect(packageJson.exports).not.toHaveProperty("./resources/skill-discovery");
    expect(packageJson.exports).not.toHaveProperty("./sdk/session-services");
    expect(packageJson.exports).not.toHaveProperty("./compaction/mechanism");
    expect(packageJson.exports).not.toHaveProperty("./provenance/source-info");
    expect(packageJson.exports).not.toHaveProperty("./execution/event-bus");
  });

  test("keeps production packages on explicit substrate subpaths", () => {
    const packageFiles = listTsFiles(join(repoRoot, "packages"));
    const violations: string[] = [];
    const rootImportPattern =
      /(?:from\s+["']@brewva\/brewva-substrate["']|import\s*\(\s*["']@brewva\/brewva-substrate["']\s*\))/;

    for (const file of packageFiles) {
      if (file === join(substrateSrc, "index.ts")) {
        continue;
      }

      let source: string;
      try {
        source = read(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }

      if (rootImportPattern.test(source)) {
        violations.push(relative(repoRoot, file));
      }
    }

    expect(violations).toEqual([]);
  });
});
