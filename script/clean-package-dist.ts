#!/usr/bin/env bun

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";

const SOURCE_ASSET_EXTENSIONS = new Set([".json"]);

function listFiles(rootDir: string): string[] {
  if (!existsSync(rootDir)) {
    return [];
  }
  const files: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      files.push(fullPath);
    }
  }

  return files;
}

function removeEmptyDirectories(rootDir: string): void {
  if (!existsSync(rootDir)) {
    return;
  }
  const entries = readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const childDir = join(rootDir, entry.name);
    removeEmptyDirectories(childDir);
  }

  if (readdirSync(rootDir).length === 0) {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function buildExpectedOutputs(srcDir: string, distDir: string): Set<string> {
  const expected = new Set<string>();
  for (const sourceFile of listFiles(srcDir)) {
    if (!sourceFile.endsWith(".ts")) {
      if (SOURCE_ASSET_EXTENSIONS.has(extname(sourceFile))) {
        const relativeSourcePath = relative(srcDir, sourceFile).replace(/\\/gu, "/");
        expected.add(join(distDir, relativeSourcePath));
      }
      continue;
    }
    const relativeSourcePath = relative(srcDir, sourceFile).replace(/\\/gu, "/");
    const outputBase = relativeSourcePath.replace(/\.ts$/u, "");
    expected.add(join(distDir, `${outputBase}.js`));
    expected.add(join(distDir, `${outputBase}.d.ts`));
    expected.add(join(distDir, `${outputBase}.js.map`));
    expected.add(join(distDir, `${outputBase}.d.ts.map`));
  }
  return expected;
}

function copySourceAssets(srcDir: string, distDir: string): void {
  for (const sourceFile of listFiles(srcDir)) {
    if (!SOURCE_ASSET_EXTENSIONS.has(extname(sourceFile))) {
      continue;
    }
    const relativeSourcePath = relative(srcDir, sourceFile).replace(/\\/gu, "/");
    const outputPath = join(distDir, relativeSourcePath);
    mkdirSync(dirname(outputPath), { recursive: true });
    cpSync(sourceFile, outputPath);
  }
}

function main(): void {
  const packagesRoot = join(process.cwd(), "packages");
  const packageDirs = readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesRoot, entry.name))
    .filter(
      (packageDir) =>
        existsSync(join(packageDir, "package.json")) && existsSync(join(packageDir, "src")),
    );

  for (const packageDir of packageDirs) {
    const srcDir = join(packageDir, "src");
    const distDir = join(packageDir, "dist");
    const expectedOutputs = buildExpectedOutputs(srcDir, distDir);
    copySourceAssets(srcDir, distDir);

    for (const distFile of listFiles(distDir)) {
      if (expectedOutputs.has(distFile)) {
        continue;
      }
      rmSync(distFile, { force: true });
    }

    removeEmptyDirectories(distDir);
  }
}

main();
