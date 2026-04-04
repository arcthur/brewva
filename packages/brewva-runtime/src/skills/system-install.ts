import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { formatISO } from "date-fns";
import { resolveGlobalBrewvaRootDir } from "../config/paths.js";
import type { SkillSystemInstallResult } from "../contracts/index.js";

const SYSTEM_SKILLS_DIR_NAME = ".system";
const SYSTEM_SKILLS_MARKER_FILE_NAME = ".system.marker.json";
const LEGACY_GLOBAL_SKILLS_MANIFEST_FILE_NAME = ".brewva-manifest.json";
const SYSTEM_SKILLS_MARKER_SCHEMA_VERSION = 1;

export interface EnsureBundledSystemSkillsInput {
  globalRootDir?: string;
  bundledSourceDir?: string;
  execPath?: string;
  moduleUrl?: string;
}

interface BundledSkillFileEntry {
  absolutePath: string;
  relativePath: string;
}

interface SystemSkillsMarker {
  schemaVersion: number;
  fingerprint: string;
  installedAt: string;
  fileCount: number;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function toPortableRelPath(pathText: string): string {
  return pathText.split(sep).join("/");
}

function listBundledSkillFiles(rootDir: string): BundledSkillFileEntry[] {
  const resolvedRoot = resolve(rootDir);
  const out: BundledSkillFileEntry[] = [];

  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).toSorted((left, right) =>
      left.name.localeCompare(right.name),
    );

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;

      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;

      out.push({
        absolutePath,
        relativePath: toPortableRelPath(relative(resolvedRoot, absolutePath)),
      });
    }
  };

  walk(resolvedRoot);
  return out;
}

function fingerprintBundledSkillPayload(bundledSourceDir: string): {
  fingerprint: string;
  fileCount: number;
} {
  const hash = createHash("sha256");
  const files = listBundledSkillFiles(bundledSourceDir);

  for (const entry of files) {
    hash.update(entry.relativePath, "utf8");
    hash.update("\0", "utf8");
    hash.update(readFileSync(entry.absolutePath));
    hash.update("\0", "utf8");
  }

  return {
    fingerprint: hash.digest("hex"),
    fileCount: files.length,
  };
}

function readMarker(markerPath: string): SystemSkillsMarker | undefined {
  if (!existsSync(markerPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<SystemSkillsMarker>;
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.schemaVersion === SYSTEM_SKILLS_MARKER_SCHEMA_VERSION &&
      typeof parsed.fingerprint === "string" &&
      typeof parsed.installedAt === "string" &&
      typeof parsed.fileCount === "number"
    ) {
      return {
        schemaVersion: parsed.schemaVersion,
        fingerprint: parsed.fingerprint,
        installedAt: parsed.installedAt,
        fileCount: parsed.fileCount,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function writeMarker(markerPath: string, marker: SystemSkillsMarker): void {
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

function copyDirectoryContents(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    cpSync(join(sourceDir, entry.name), join(targetDir, entry.name), {
      recursive: true,
      force: true,
    });
  }
}

function pruneEmptyDirectories(startDir: string, stopDir: string): void {
  let current = resolve(startDir);
  const resolvedStopDir = resolve(stopDir);
  while (current !== resolvedStopDir && current.startsWith(resolvedStopDir + sep)) {
    try {
      if (readdirSync(current).length > 0) {
        return;
      }
      rmSync(current, { recursive: false, force: true });
    } catch {
      return;
    }
    current = dirname(current);
  }
}

function cleanupLegacyGlobalSkillsSeed(globalRootDir: string): boolean {
  const globalSkillsRoot = join(globalRootDir, "skills");
  const manifestPath = join(globalSkillsRoot, LEGACY_GLOBAL_SKILLS_MANIFEST_FILE_NAME);
  if (!existsSync(manifestPath)) return false;

  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { files?: unknown };
    const files = Array.isArray(parsed.files)
      ? parsed.files.filter((entry): entry is string => typeof entry === "string")
      : [];

    for (const relativePath of files) {
      const trimmed = relativePath.trim();
      if (!trimmed || trimmed.startsWith(`${SYSTEM_SKILLS_DIR_NAME}/`)) continue;
      const absolutePath = join(globalSkillsRoot, trimmed);
      rmSync(absolutePath, { recursive: true, force: true });
      pruneEmptyDirectories(dirname(absolutePath), globalSkillsRoot);
    }
  } catch {
    // Ignore malformed legacy manifests and still remove the marker file below.
  }

  rmSync(manifestPath, { force: true });
  return true;
}

function installBundledSystemSkillsTree(sourceDir: string, targetDir: string): void {
  const parentDir = dirname(targetDir);
  mkdirSync(parentDir, { recursive: true });

  const tempDir = join(parentDir, `.${SYSTEM_SKILLS_DIR_NAME}.tmp-${randomUUID()}`);
  rmSync(tempDir, { recursive: true, force: true });

  try {
    copyDirectoryContents(sourceDir, tempDir);
    rmSync(targetDir, { recursive: true, force: true });
    renameSync(tempDir, targetDir);
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function resolveBundledSkillsSourceDir(input: EnsureBundledSystemSkillsInput): string {
  if (input.bundledSourceDir) {
    const resolvedOverride = resolve(input.bundledSourceDir);
    if (!isDirectory(resolvedOverride)) {
      throw new Error(
        `[skills_system_install] bundled skills payload is not a directory: ${resolvedOverride}`,
      );
    }
    return resolvedOverride;
  }

  const execSkillsDir = join(dirname(resolve(input.execPath ?? process.execPath)), "skills");
  if (isDirectory(execSkillsDir)) {
    return execSkillsDir;
  }

  const modulePath = fileURLToPath(input.moduleUrl ?? import.meta.url);
  const checkoutSkillsDir = resolve(dirname(modulePath), "../../../../skills");
  if (isDirectory(checkoutSkillsDir)) {
    return checkoutSkillsDir;
  }

  throw new Error(
    `[skills_system_install] bundled skills payload not found. Checked ${execSkillsDir} and ${checkoutSkillsDir}.`,
  );
}

export function resolveBundledSystemSkillsRoot(globalRootDir: string): string {
  return join(globalRootDir, "skills", SYSTEM_SKILLS_DIR_NAME);
}

export function resolveBundledSystemSkillsMarkerPath(globalRootDir: string): string {
  return join(globalRootDir, "skills", SYSTEM_SKILLS_MARKER_FILE_NAME);
}

export function ensureBundledSystemSkills(
  input: EnsureBundledSystemSkillsInput = {},
): SkillSystemInstallResult {
  const globalRootDir = resolve(input.globalRootDir ?? resolveGlobalBrewvaRootDir());
  const bundledSourceDir = resolveBundledSkillsSourceDir(input);
  const systemRoot = resolveBundledSystemSkillsRoot(globalRootDir);
  const markerPath = resolveBundledSystemSkillsMarkerPath(globalRootDir);
  const migratedLegacyGlobalSeed = cleanupLegacyGlobalSkillsSeed(globalRootDir);
  const { fingerprint, fileCount } = fingerprintBundledSkillPayload(bundledSourceDir);
  const marker = readMarker(markerPath);

  if (marker?.fingerprint === fingerprint && isDirectory(systemRoot)) {
    return {
      systemRoot,
      fingerprint,
      installed: false,
      migratedLegacyGlobalSeed,
    };
  }

  installBundledSystemSkillsTree(bundledSourceDir, systemRoot);
  writeMarker(markerPath, {
    schemaVersion: SYSTEM_SKILLS_MARKER_SCHEMA_VERSION,
    fingerprint,
    installedAt: formatISO(Date.now()),
    fileCount,
  });

  return {
    systemRoot,
    fingerprint,
    installed: true,
    migratedLegacyGlobalSeed,
  };
}
