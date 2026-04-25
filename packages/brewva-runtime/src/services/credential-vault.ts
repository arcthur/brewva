import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, resolve } from "node:path";
import type { BrewvaConfig } from "../contracts/index.js";
import { registerRuntimeSecret } from "../security/redact.js";
import { normalizeToolName } from "../utils/tool-name.js";

interface EncryptedVaultEntry {
  ref: string;
  nonce: string;
  ciphertext: string;
  authTag: string;
  createdAt: number;
  updatedAt: number;
}

interface EncryptedVaultFile {
  version: 1;
  entries: EncryptedVaultEntry[];
}

export interface CredentialVaultListEntry {
  ref: string;
  maskedValue: string;
  createdAt: number;
  updatedAt: number;
}

export interface CredentialVaultDiscoveredEntry {
  provider: string;
  envVar: string;
  maskedValue: string;
  credentialRef: string;
}

export interface CredentialVaultServiceOptions {
  vaultPath: string;
  masterKeyEnv?: string;
  allowDerivedKeyFallback?: boolean;
  env?: Record<string, string | undefined>;
  machineHostname?: string;
  machineHomeDir?: string;
}

const DEFAULT_MASTER_KEY_ENV = "BREWVA_VAULT_KEY";

const DISCOVERY_MAPPINGS: Array<{
  provider: string;
  envVar: string;
  credentialRef: string;
}> = [
  { provider: "openai", envVar: "OPENAI_API_KEY", credentialRef: "vault://openai/apiKey" },
  { provider: "anthropic", envVar: "ANTHROPIC_API_KEY", credentialRef: "vault://anthropic/apiKey" },
  { provider: "github", envVar: "GITHUB_TOKEN", credentialRef: "vault://github/token" },
  { provider: "github", envVar: "GH_TOKEN", credentialRef: "vault://github/token" },
  { provider: "gemini", envVar: "GEMINI_API_KEY", credentialRef: "vault://gemini/apiKey" },
  { provider: "google", envVar: "GOOGLE_API_KEY", credentialRef: "vault://google/apiKey" },
  { provider: "mistral", envVar: "MISTRAL_API_KEY", credentialRef: "vault://mistral/apiKey" },
  { provider: "groq", envVar: "GROQ_API_KEY", credentialRef: "vault://groq/apiKey" },
  { provider: "together", envVar: "TOGETHER_API_KEY", credentialRef: "vault://together/apiKey" },
  { provider: "xai", envVar: "XAI_API_KEY", credentialRef: "vault://xai/apiKey" },
];

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function maskValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 10) {
    return `${trimmed.slice(0, 2)}...[redacted]`;
  }
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

function normalizeRef(ref: string): string {
  return ref.trim();
}

function deriveFallbackKey(input: { machineHostname: string; machineHomeDir: string }): Buffer {
  return createHash("sha256")
    .update(`brewva:${input.machineHostname}:${input.machineHomeDir}`)
    .digest();
}

function encodeBase64(value: Buffer): string {
  return value.toString("base64");
}

function decodeBase64(value: string): Buffer {
  return Buffer.from(value, "base64");
}

function readVaultFile(vaultPath: string): EncryptedVaultFile {
  const absolutePath = resolve(vaultPath);
  if (!existsSync(absolutePath)) {
    return {
      version: 1,
      entries: [],
    };
  }

  const raw = JSON.parse(readFileSync(absolutePath, "utf8")) as unknown;
  if (
    !raw ||
    typeof raw !== "object" ||
    (raw as { version?: unknown }).version !== 1 ||
    !Array.isArray((raw as { entries?: unknown }).entries)
  ) {
    throw new Error(`Invalid credential vault file: ${absolutePath}`);
  }

  const entries: EncryptedVaultEntry[] = [];
  for (const entry of (raw as { entries: unknown[] }).entries ?? []) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const candidate = entry as Partial<EncryptedVaultEntry>;
    if (
      typeof candidate.ref !== "string" ||
      typeof candidate.nonce !== "string" ||
      typeof candidate.ciphertext !== "string" ||
      typeof candidate.authTag !== "string" ||
      typeof candidate.createdAt !== "number" ||
      typeof candidate.updatedAt !== "number"
    ) {
      continue;
    }
    entries.push({
      ref: candidate.ref,
      nonce: candidate.nonce,
      ciphertext: candidate.ciphertext,
      authTag: candidate.authTag,
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
    });
  }

  return {
    version: 1,
    entries,
  };
}

function writeVaultFile(vaultPath: string, file: EncryptedVaultFile): void {
  const absolutePath = resolve(vaultPath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  const tempPath = `${absolutePath}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tempPath, absolutePath);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // best effort
    }
    throw error;
  }
}

export function createCredentialVaultServiceFromSecurityConfig(
  workspaceRoot: string,
  security: BrewvaConfig["security"],
): CredentialVaultService {
  return new CredentialVaultService({
    vaultPath: resolve(workspaceRoot, security.credentials.path),
    masterKeyEnv: security.credentials.masterKeyEnv,
    allowDerivedKeyFallback: security.credentials.allowDerivedKeyFallback,
  });
}

export class CredentialVaultService {
  private readonly vaultPath: string;
  private readonly masterKeyEnv: string;
  private readonly allowDerivedKeyFallback: boolean;
  private readonly env: Record<string, string | undefined>;
  private readonly machineHostname: string;
  private readonly machineHomeDir: string;

  constructor(options: CredentialVaultServiceOptions) {
    this.vaultPath = resolve(options.vaultPath);
    this.masterKeyEnv = readString(options.masterKeyEnv) ?? DEFAULT_MASTER_KEY_ENV;
    this.allowDerivedKeyFallback = options.allowDerivedKeyFallback !== false;
    this.env = options.env ?? process.env;
    this.machineHostname = readString(options.machineHostname) ?? hostname();
    this.machineHomeDir = readString(options.machineHomeDir) ?? homedir();
  }

  private resolveKey(): Buffer {
    const explicit = readString(this.env[this.masterKeyEnv]);
    if (explicit) {
      return createHash("sha256").update(explicit).digest();
    }
    if (!this.allowDerivedKeyFallback) {
      throw new Error(`Credential vault key is missing (${this.masterKeyEnv}).`);
    }
    return deriveFallbackKey({
      machineHostname: this.machineHostname,
      machineHomeDir: this.machineHomeDir,
    });
  }

  private encrypt(value: string): {
    nonce: string;
    ciphertext: string;
    authTag: string;
  } {
    const key = this.resolveKey();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      nonce: encodeBase64(nonce),
      ciphertext: encodeBase64(ciphertext),
      authTag: encodeBase64(authTag),
    };
  }

  private decrypt(entry: EncryptedVaultEntry): string {
    const key = this.resolveKey();
    const decipher = createDecipheriv("aes-256-gcm", key, decodeBase64(entry.nonce));
    decipher.setAuthTag(decodeBase64(entry.authTag));
    const plaintext = Buffer.concat([
      decipher.update(decodeBase64(entry.ciphertext)),
      decipher.final(),
    ]).toString("utf8");
    registerRuntimeSecret(plaintext);
    return plaintext;
  }

  private load(): EncryptedVaultFile {
    return readVaultFile(this.vaultPath);
  }

  private save(file: EncryptedVaultFile): void {
    writeVaultFile(this.vaultPath, file);
  }

  get(ref: string): string | undefined {
    const normalizedRef = normalizeRef(ref);
    if (!normalizedRef) {
      return undefined;
    }
    const file = this.load();
    const entry = file.entries.find((candidate) => candidate.ref === normalizedRef);
    return entry ? this.decrypt(entry) : undefined;
  }

  put(ref: string, value: string): void {
    const normalizedRef = normalizeRef(ref);
    const normalizedValue = readString(value);
    if (!normalizedRef || !normalizedValue) {
      throw new Error("Credential vault put requires non-empty ref and value.");
    }
    const file = this.load();
    const now = Date.now();
    const encrypted = this.encrypt(normalizedValue);
    registerRuntimeSecret(normalizedValue);
    const existing = file.entries.find((entry) => entry.ref === normalizedRef);
    if (existing) {
      existing.nonce = encrypted.nonce;
      existing.ciphertext = encrypted.ciphertext;
      existing.authTag = encrypted.authTag;
      existing.updatedAt = now;
    } else {
      file.entries.push({
        ref: normalizedRef,
        nonce: encrypted.nonce,
        ciphertext: encrypted.ciphertext,
        authTag: encrypted.authTag,
        createdAt: now,
        updatedAt: now,
      });
    }
    this.save(file);
  }

  remove(ref: string): boolean {
    const normalizedRef = normalizeRef(ref);
    if (!normalizedRef) {
      return false;
    }
    const file = this.load();
    const nextEntries = file.entries.filter((entry) => entry.ref !== normalizedRef);
    if (nextEntries.length === file.entries.length) {
      return false;
    }
    file.entries = nextEntries;
    this.save(file);
    return true;
  }

  list(): CredentialVaultListEntry[] {
    const file = this.load();
    return file.entries
      .map((entry) => {
        const value = this.decrypt(entry);
        return {
          ref: entry.ref,
          maskedValue: maskValue(value),
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        };
      })
      .toSorted((left, right) => left.ref.localeCompare(right.ref));
  }

  discover(env: Record<string, string | undefined> = this.env): CredentialVaultDiscoveredEntry[] {
    return DISCOVERY_MAPPINGS.flatMap((entry) => {
      const value = readString(env[entry.envVar]);
      if (!value) {
        return [];
      }
      registerRuntimeSecret(value);
      return [
        {
          provider: entry.provider,
          envVar: entry.envVar,
          maskedValue: maskValue(value),
          credentialRef: entry.credentialRef,
        },
      ];
    });
  }

  resolveToolBindings(
    toolName: string,
    bindings: ReadonlyArray<BrewvaConfig["security"]["credentials"]["bindings"][number]>,
  ): Record<string, string> {
    const normalizedToolName = normalizeToolName(toolName);
    const env: Record<string, string> = {};
    for (const binding of bindings) {
      if (binding.toolNames.length > 0 && !binding.toolNames.includes(normalizedToolName)) {
        continue;
      }
      const value = this.get(binding.credentialRef);
      if (!value) {
        continue;
      }
      env[binding.envVar] = value;
    }
    return env;
  }

  resolveConfiguredSecret(ref: string | undefined): string | undefined {
    const normalizedRef = readString(ref);
    if (!normalizedRef) {
      return undefined;
    }
    return this.get(normalizedRef);
  }
}
