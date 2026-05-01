import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const runtimeSrcRoot = resolve(repoRoot, "packages/brewva-runtime/src");
const runtimeDomainRoot = resolve(runtimeSrcRoot, "domain");

function listSourceFiles(absoluteDir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(absoluteDir)) {
    const absolutePath = resolve(absoluteDir, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      files.push(...listSourceFiles(absolutePath));
      continue;
    }
    if (stats.isFile() && /\.(?:ts|tsx)$/u.test(entry)) {
      files.push(absolutePath);
    }
  }
  return files;
}

function readSrcFile(relativeToSrc: string): string {
  return readFileSync(resolve(runtimeSrcRoot, relativeToSrc), "utf-8");
}

const MIGRATED_TOP_LEVEL_DIRS = [
  "channels",
  "iteration",
  "workflow",
  "evidence",
  "authority",
  "projection",
  "state",
] as const;

const REQUIRED_DOMAIN_DIRS = [
  "channels",
  "iteration",
  "workflow",
  "evidence",
  "projection",
  "governance",
  "sessions",
  "recovery",
] as const;

describe("runtime domain migration guard", () => {
  test("removed top-level src directories no longer exist", () => {
    for (const name of MIGRATED_TOP_LEVEL_DIRS) {
      const absolutePath = resolve(runtimeSrcRoot, name);
      expect(existsSync(absolutePath), `top-level src/${name} must be removed`).toBe(false);
    }
  });

  test("each migrated domain lives under packages/brewva-runtime/src/domain/", () => {
    for (const name of REQUIRED_DOMAIN_DIRS) {
      const absolutePath = resolve(runtimeDomainRoot, name);
      expect(existsSync(absolutePath), `domain/${name} must exist`).toBe(true);
      expect(statSync(absolutePath).isDirectory()).toBe(true);
    }
  });

  test("former authority/* contents live inside domain/governance", () => {
    const governanceDir = resolve(runtimeDomainRoot, "governance");
    const governanceSources = readdirSync(governanceDir);
    expect(governanceSources).toContain("effect-authority-manifest.ts");
    expect(governanceSources).toContain("action-policy.ts");
    expect(governanceSources).toContain("port.ts");
    expect(existsSync(resolve(runtimeSrcRoot, "authority"))).toBe(false);
  });

  test("former state/ store now belongs to domain/sessions", () => {
    expect(existsSync(resolve(runtimeSrcRoot, "state"))).toBe(false);
    expect(existsSync(resolve(runtimeDomainRoot, "sessions/session-state.ts"))).toBe(true);
  });

  test("recovery wal modules live under domain/recovery (not channels)", () => {
    expect(existsSync(resolve(runtimeDomainRoot, "recovery/wal-store.ts"))).toBe(true);
    expect(existsSync(resolve(runtimeDomainRoot, "recovery/wal-recovery.ts"))).toBe(true);
    expect(existsSync(resolve(runtimeDomainRoot, "recovery/wal-maintenance.ts"))).toBe(true);
    expect(existsSync(resolve(runtimeDomainRoot, "recovery/tool-lifecycle-recovery-wal.ts"))).toBe(
      true,
    );
    expect(existsSync(resolve(runtimeSrcRoot, "channels/recovery-wal.ts"))).toBe(false);
    expect(existsSync(resolve(runtimeSrcRoot, "channels/recovery-wal-recovery.ts"))).toBe(false);
    expect(existsSync(resolve(runtimeSrcRoot, "channels/recovery-wal-maintenance.ts"))).toBe(false);
  });

  test("recovery subpath stub re-exports through domain/recovery", () => {
    const recoverySource = readSrcFile("recovery.ts");
    expect(recoverySource).toContain("./domain/recovery/api.js");
    expect(recoverySource).toContain("./domain/schedule/api.js");
    expect(recoverySource).not.toContain("./channels/recovery-wal");
    expect(recoverySource).not.toContain("./channels/recovery-wal-recovery");
  });

  test("no source file imports from removed top-level paths", () => {
    const offenders: string[] = [];
    const removedRootSpecifierPattern = new RegExp(
      String.raw`from\s+["'][^"']*?(?:^|\/)(${MIGRATED_TOP_LEVEL_DIRS.join("|")})\/[^"']+["']`,
      "u",
    );
    for (const sourceFile of listSourceFiles(runtimeSrcRoot)) {
      const relative = sourceFile.replace(`${runtimeSrcRoot}/`, "");
      const source = readFileSync(sourceFile, "utf-8");
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/gu)) {
        const specifier = match[1];
        if (!specifier || !specifier.startsWith(".")) {
          continue;
        }
        const absoluteTarget = resolve(sourceFile, "..", specifier);
        if (!absoluteTarget.startsWith(`${runtimeSrcRoot}/`)) {
          continue;
        }
        const targetRelative = absoluteTarget.replace(`${runtimeSrcRoot}/`, "");
        const head = targetRelative.split("/")[0] ?? "";
        if ((MIGRATED_TOP_LEVEL_DIRS as readonly string[]).includes(head)) {
          offenders.push(`${relative} -> ${targetRelative}`);
        }
      }
      void removedRootSpecifierPattern;
    }
    expect(offenders).toEqual([]);
  });
});
