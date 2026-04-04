import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getBinaryPath, getPlatformPackage } from "./bin/platform.js";

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

const require = createRequire(import.meta.url);

export function buildDefaultGlobalBrewvaConfig() {
  return {
    ui: {
      quietStartup: true,
    },
    skills: {
      roots: [],
      disabled: [],
      overrides: {},
      routing: {
        enabled: false,
        scopes: ["core", "domain"],
      },
    },
  };
}

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

function normalizePathInput(input) {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

function resolveMaybeAbsolute(baseDir, pathText) {
  const normalized = normalizePathInput(pathText);
  if (isAbsolute(normalized)) {
    return resolve(normalized);
  }
  return resolve(baseDir, normalized);
}

function resolveGlobalBrewvaRootDir(env = process.env) {
  const fromBrewva =
    typeof env["BREWVA_CODING_AGENT_DIR"] === "string" ? env["BREWVA_CODING_AGENT_DIR"] : "";
  if (fromBrewva.trim().length > 0) {
    return resolve(resolveMaybeAbsolute(process.cwd(), fromBrewva), "..");
  }

  const configured = typeof env.XDG_CONFIG_HOME === "string" ? env.XDG_CONFIG_HOME : "";
  if (configured.trim().length > 0) {
    return resolveMaybeAbsolute(process.cwd(), join(configured, "brewva"));
  }
  return resolve(homedir(), ".config", "brewva");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepMerge(base, override) {
  if (!isRecord(base)) return cloneJsonValue(override);
  if (!isRecord(override)) return cloneJsonValue(base);

  const result = cloneJsonValue(base);
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (isRecord(current) && isRecord(value)) {
      result[key] = deepMerge(current, value);
      continue;
    }
    result[key] = cloneJsonValue(value);
  }
  return result;
}

function seedGlobalConfig(globalRoot, defaultConfig) {
  mkdirSync(globalRoot, { recursive: true });
  const configPath = join(globalRoot, "brewva.json");

  if (!existsSync(configPath)) {
    writeFileSync(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`, "utf8");
    console.log(`brewva: created global config at ${configPath}`);
    return;
  }

  try {
    const existing = JSON.parse(readFileSync(configPath, "utf8"));
    if (!isRecord(existing)) {
      console.warn(`brewva: skipped renewing config (not an object): ${configPath}`);
      return;
    }
    const merged = deepMerge(defaultConfig, existing);
    writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    console.log(`brewva: renewed global config at ${configPath}`);
  } catch {
    console.warn(`brewva: skipped renewing config (invalid JSON): ${configPath}`);
  }
}

export function main() {
  const { platform, arch } = process;
  const libcFamily = getLibcFamily();
  const globalRoot = resolveGlobalBrewvaRootDir(process.env);
  let runtimeBinaryPath;

  try {
    const pkg = getPlatformPackage({ platform, arch, libcFamily });
    const binPath = getBinaryPath(pkg, platform);
    runtimeBinaryPath = require.resolve(binPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`brewva: ${message}`);
    console.warn("brewva: platform binary is unavailable on this system.");
  }

  try {
    seedGlobalConfig(globalRoot, buildDefaultGlobalBrewvaConfig());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`brewva: failed to seed global config: ${message}`);
  }

  if (!runtimeBinaryPath) {
    return;
  }
  console.log(`brewva: installed platform binary for ${platform}-${arch}`);
}

function shouldRunMain() {
  const entryArg = typeof process.argv[1] === "string" ? process.argv[1] : "";
  if (!entryArg) return false;
  return resolve(entryArg) === fileURLToPath(import.meta.url);
}

if (shouldRunMain()) {
  main();
}
