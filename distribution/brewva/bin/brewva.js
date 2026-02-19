#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { getBinaryPath, getPlatformPackage } from "./platform.js";

const require = createRequire(import.meta.url);
const NODE_VERSION_RANGE = "^20.19.0 || >=22.12.0";

function parseSemver(versionText) {
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

function isSupportedNodeVersion(version) {
  if (version.major === 20) return version.minor >= 19;
  if (version.major === 21) return false;
  if (version.major === 22) return version.minor >= 12;
  return version.major > 22;
}

function assertSupportedNodeRuntime() {
  const detected =
    typeof process.versions?.node === "string" ? process.versions.node : process.version;
  const parsed = parseSemver(process.versions?.node ?? process.version);
  if (!parsed || !isSupportedNodeVersion(parsed)) {
    console.error(
      `brewva: unsupported Node.js version ${detected}. Brewva requires Node.js ${NODE_VERSION_RANGE} (ES2023 baseline).`,
    );
    process.exit(1);
  }
}

assertSupportedNodeRuntime();

function getLibcFamily() {
  if (process.platform !== "linux") {
    return undefined;
  }

  try {
    const detectLibc = require("detect-libc");
    return detectLibc.familySync();
  } catch {
    return null;
  }
}

function resolveBinaryPath() {
  const { platform, arch } = process;
  const libcFamily = getLibcFamily();

  const pkg = getPlatformPackage({ platform, arch, libcFamily });
  const binRelPath = getBinaryPath(pkg, platform);

  try {
    return require.resolve(binRelPath);
  } catch {
    const suffix = libcFamily === "musl" ? "-musl" : "";
    throw new Error(
      [
        "platform binary is not installed.",
        `platform: ${platform}-${arch}${suffix}`,
        `expected package: ${pkg}`,
        `try: npm install ${pkg}`,
      ].join("\n"),
    );
  }
}

function main() {
  let binPath;
  try {
    binPath = resolveBinaryPath();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`brewva: ${message}`);
    process.exit(1);
  }

  const result = spawnSync(binPath, process.argv.slice(2), {
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`brewva: failed to execute binary: ${result.error.message}`);
    process.exit(2);
  }

  if (result.signal) {
    const signalCode =
      result.signal === "SIGTERM"
        ? 15
        : result.signal === "SIGKILL"
          ? 9
          : result.signal === "SIGINT"
            ? 2
            : 1;
    process.exit(128 + signalCode);
  }

  process.exit(result.status ?? 1);
}

main();
