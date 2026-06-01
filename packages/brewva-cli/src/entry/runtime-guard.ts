import process from "node:process";
import { BrewvaConfigLoadError } from "@brewva/brewva-runtime/config";

const NODE_VERSION_RANGE = "^20.19.0 || >=22.13.0";

type Semver = Readonly<{ major: number; minor: number; patch: number }>;

function parseSemver(versionText: string | undefined): Semver | null {
  if (typeof versionText !== "string" || versionText.length === 0) return null;
  const normalized = versionText.startsWith("v") ? versionText.slice(1) : versionText;
  const match = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/u.exec(normalized);
  if (!match?.groups) return null;

  const major = Number(match.groups.major);
  const minor = Number(match.groups.minor);
  const patch = Number(match.groups.patch);

  if (!Number.isInteger(major) || major < 0) return null;
  if (!Number.isInteger(minor) || minor < 0) return null;
  if (!Number.isInteger(patch) || patch < 0) return null;

  return { major, minor, patch };
}

function isSupportedNodeVersion(version: Semver): boolean {
  if (version.major === 20) return version.minor >= 19;
  if (version.major === 21) return false;
  if (version.major === 22) return version.minor >= 13;
  return version.major > 22;
}

export function assertSupportedRuntime(): void {
  const versions = process.versions as NodeJS.ProcessVersions & { bun?: string };
  if (typeof versions.bun === "string" && versions.bun.length > 0) return;

  const detected = typeof versions.node === "string" ? versions.node : process.version;
  const parsed = parseSemver(versions.node ?? process.version);
  if (!parsed || !isSupportedNodeVersion(parsed)) {
    console.error(
      `brewva: unsupported Node.js version ${detected}. Brewva requires Node.js ${NODE_VERSION_RANGE} (ES2023 baseline).`,
    );
    process.exit(1);
  }

  if (
    typeof Array.prototype.toSorted !== "function" ||
    typeof Array.prototype.toReversed !== "function"
  ) {
    console.error(
      `brewva: Node.js ${detected} is missing ES2023 builtins (toSorted/toReversed). Please upgrade Node.js to ${NODE_VERSION_RANGE}.`,
    );
    process.exit(1);
  }
}

export function printStartupError(error: unknown): void {
  if (error instanceof BrewvaConfigLoadError) {
    console.error(`[config:error] ${error.configPath}: ${error.message}`);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
}
