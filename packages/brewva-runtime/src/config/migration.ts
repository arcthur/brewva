import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { BrewvaConfigFile } from "../contracts/index.js";
import { createCredentialVaultServiceFromSecurityConfig } from "../services/credential-vault.js";
import { DEFAULT_BREWVA_CONFIG } from "./defaults.js";
import { BrewvaConfigLoadError } from "./loader.js";
import { normalizeBrewvaConfig } from "./normalize.js";
import { resolveProjectBrewvaConfigPath, resolveWorkspaceRootDir } from "./paths.js";
import { validateBrewvaConfigFile } from "./validate.js";

type JsonRecord = Record<string, unknown>;

export type BrewvaConfigMigrationFindingCode =
  | "execution_command_deny_list_to_boundary_policy"
  | "inline_sandbox_api_key_to_vault_ref";

export interface BrewvaConfigMigrationFinding {
  code: BrewvaConfigMigrationFindingCode;
  path: string;
  replacementPath?: string;
  detail: string;
}

export interface BrewvaConfigMigrationResult {
  configPath: string;
  exists: boolean;
  changed: boolean;
  applied: boolean;
  findings: BrewvaConfigMigrationFinding[];
  validationErrors: string[];
}

export interface BrewvaConfigMigrationOptions {
  cwd?: string;
  configPath?: string;
  write?: boolean;
}

interface PlannedVaultImport {
  ref: string;
  value: string;
}

interface PlannedMigration {
  nextConfig: BrewvaConfigFile;
  changed: boolean;
  findings: BrewvaConfigMigrationFinding[];
  validationErrors: string[];
  vaultImports: PlannedVaultImport[];
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function cloneConfigRecord(value: BrewvaConfigFile): BrewvaConfigFile {
  return structuredClone(value);
}

function pruneEmptyNestedRecord(parent: JsonRecord, key: string): void {
  const value = parent[key];
  if (!isRecord(value)) {
    return;
  }
  if (Object.keys(value).length === 0) {
    delete parent[key];
  }
}

function readConfigPath(cwd: string, explicitConfigPath?: string): string {
  return explicitConfigPath
    ? resolve(cwd, explicitConfigPath)
    : resolveProjectBrewvaConfigPath(cwd);
}

function readRawConfigFile(configPath: string): BrewvaConfigFile | undefined {
  if (!existsSync(configPath)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BrewvaConfigLoadError({
      code: "config_parse_error",
      configPath,
      message: `Failed to parse config JSON: ${message}`,
    });
  }

  if (!isRecord(parsed)) {
    throw new BrewvaConfigLoadError({
      code: "config_not_object",
      configPath,
      message: "Config must be a JSON object at the top-level.",
    });
  }

  return parsed as BrewvaConfigFile;
}

function writeConfigFile(configPath: string, config: BrewvaConfigFile): void {
  const absolutePath = resolve(configPath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  const tempPath = `${absolutePath}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
    });
    renameSync(tempPath, absolutePath);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // best effort temp cleanup
    }
    throw error;
  }
}

function planCommandDenyListMigration(
  securityRecord: JsonRecord,
  findings: BrewvaConfigMigrationFinding[],
): boolean {
  const execution = securityRecord["execution"];
  if (!isRecord(execution)) {
    return false;
  }
  if (!Object.prototype.hasOwnProperty.call(execution, "commandDenyList")) {
    return false;
  }

  const boundaryPolicyValue = securityRecord["boundaryPolicy"];
  if (boundaryPolicyValue !== undefined && !isRecord(boundaryPolicyValue)) {
    return false;
  }
  const boundaryPolicy = isRecord(boundaryPolicyValue) ? boundaryPolicyValue : {};
  const merged = dedupeStrings([
    ...normalizeStringArray(boundaryPolicy["commandDenyList"]),
    ...normalizeStringArray(execution["commandDenyList"]),
  ]);

  findings.push({
    code: "execution_command_deny_list_to_boundary_policy",
    path: "security.execution.commandDenyList",
    replacementPath: "security.boundaryPolicy.commandDenyList",
    detail:
      merged.length > 0
        ? `Move ${merged.length} command entr${merged.length === 1 ? "y" : "ies"} into security.boundaryPolicy.commandDenyList.`
        : "Delete security.execution.commandDenyList because runtime only reads security.boundaryPolicy.commandDenyList.",
  });

  delete execution["commandDenyList"];
  if (merged.length > 0) {
    boundaryPolicy["commandDenyList"] = merged;
  } else if (isRecord(boundaryPolicyValue)) {
    delete boundaryPolicy["commandDenyList"];
  }

  if (!isRecord(boundaryPolicyValue)) {
    if (Object.keys(boundaryPolicy).length > 0) {
      securityRecord["boundaryPolicy"] = boundaryPolicy;
    }
  } else {
    pruneEmptyNestedRecord(securityRecord, "boundaryPolicy");
  }

  pruneEmptyNestedRecord(securityRecord, "execution");
  return true;
}

function planInlineSandboxApiKeyMigration(
  securityRecord: JsonRecord,
  findings: BrewvaConfigMigrationFinding[],
  vaultImports: PlannedVaultImport[],
): boolean {
  const execution = securityRecord["execution"];
  if (!isRecord(execution)) {
    return false;
  }
  const sandbox = execution["sandbox"];
  if (!isRecord(sandbox) || !Object.prototype.hasOwnProperty.call(sandbox, "apiKey")) {
    return false;
  }

  const inlineApiKey = normalizeNonEmptyString(sandbox["apiKey"]);
  delete sandbox["apiKey"];
  pruneEmptyNestedRecord(execution, "sandbox");
  pruneEmptyNestedRecord(securityRecord, "execution");

  if (!inlineApiKey) {
    findings.push({
      code: "inline_sandbox_api_key_to_vault_ref",
      path: "security.execution.sandbox.apiKey",
      replacementPath: "security.credentials.sandboxApiKeyRef",
      detail:
        "Delete security.execution.sandbox.apiKey because runtime resolves sandbox keys through security.credentials.sandboxApiKeyRef.",
    });
    return true;
  }

  const credentialsValue = securityRecord["credentials"];
  if (credentialsValue !== undefined && !isRecord(credentialsValue)) {
    return false;
  }
  const credentials = isRecord(credentialsValue) ? credentialsValue : {};
  const vaultRef =
    normalizeNonEmptyString(credentials["sandboxApiKeyRef"]) ??
    DEFAULT_BREWVA_CONFIG.security.credentials.sandboxApiKeyRef ??
    "vault://sandbox/apiKey";
  credentials["sandboxApiKeyRef"] = vaultRef;
  if (!isRecord(credentialsValue)) {
    securityRecord["credentials"] = credentials;
  }

  vaultImports.push({
    ref: vaultRef,
    value: inlineApiKey,
  });
  findings.push({
    code: "inline_sandbox_api_key_to_vault_ref",
    path: "security.execution.sandbox.apiKey",
    replacementPath: "security.credentials.sandboxApiKeyRef",
    detail: `Import the inline sandbox API key into vault ref ${vaultRef} and remove security.execution.sandbox.apiKey.`,
  });
  return true;
}

function planConfigMigration(rawConfig: BrewvaConfigFile): PlannedMigration {
  const nextConfig = cloneConfigRecord(rawConfig);
  const findings: BrewvaConfigMigrationFinding[] = [];
  const vaultImports: PlannedVaultImport[] = [];

  const securityRecord = nextConfig.security;
  if (isRecord(securityRecord)) {
    const commandDenyListChanged = planCommandDenyListMigration(securityRecord, findings);
    const inlineSandboxApiKeyChanged = planInlineSandboxApiKeyMigration(
      securityRecord,
      findings,
      vaultImports,
    );
    if (commandDenyListChanged || inlineSandboxApiKeyChanged) {
      pruneEmptyNestedRecord(nextConfig as JsonRecord, "security");
    }
  }

  const validation = validateBrewvaConfigFile(nextConfig);
  const validationErrors = validation.ok
    ? []
    : validation.errors.length > 0
      ? validation.errors
      : validation.error
        ? [validation.error]
        : ["Config schema validation failed."];
  return {
    nextConfig,
    changed: findings.length > 0,
    findings,
    validationErrors,
    vaultImports,
  };
}

export async function migrateBrewvaConfig(
  options: BrewvaConfigMigrationOptions = {},
): Promise<BrewvaConfigMigrationResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = readConfigPath(cwd, options.configPath);
  const rawConfig = readRawConfigFile(configPath);
  if (!rawConfig) {
    return {
      configPath,
      exists: false,
      changed: false,
      applied: false,
      findings: [],
      validationErrors: [],
    };
  }

  const plan = planConfigMigration(rawConfig);
  if (plan.validationErrors.length > 0 || !options.write || !plan.changed) {
    return {
      configPath,
      exists: true,
      changed: plan.changed,
      applied: false,
      findings: plan.findings,
      validationErrors: plan.validationErrors,
    };
  }

  const runtimeConfig = normalizeBrewvaConfig(plan.nextConfig, DEFAULT_BREWVA_CONFIG);
  const workspaceRoot = resolveWorkspaceRootDir(cwd);
  const vault = createCredentialVaultServiceFromSecurityConfig(
    workspaceRoot,
    runtimeConfig.security,
  );
  for (const entry of plan.vaultImports) {
    vault.put(entry.ref, entry.value);
  }
  writeConfigFile(configPath, plan.nextConfig);

  return {
    configPath,
    exists: true,
    changed: plan.changed,
    applied: true,
    findings: plan.findings,
    validationErrors: [],
  };
}
