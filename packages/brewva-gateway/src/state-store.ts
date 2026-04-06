import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CredentialVaultService } from "@brewva/brewva-runtime/internal";

export interface ChildRegistryEntry {
  sessionId: string;
  pid: number;
  startedAt: number;
  agentSessionId?: string;
  agentEventLogPath?: string;
  cwd?: string;
}

export interface GatewayStateStore {
  readToken(tokenFilePath: string): string | undefined;
  writeToken(tokenFilePath: string, token: string): void;
  reconcileReadToken?(tokenFilePath: string, token: string): void;
  readChildrenRegistry(registryPath: string): ChildRegistryEntry[];
  writeChildrenRegistry(registryPath: string, entries: ReadonlyArray<ChildRegistryEntry>): void;
  removeChildrenRegistry(registryPath: string): void;
}

interface GatewayTokenVaultOptions {
  vaultPath: string;
  credentialRef: string;
  masterKeyEnv?: string;
  allowDerivedKeyFallback?: boolean;
}

interface GatewayTokenPointerFile {
  schema: "brewva.gateway-token-pointer.v1";
  vaultPath: string;
  credentialRef: string;
  masterKeyEnv?: string;
  allowDerivedKeyFallback?: boolean;
}

function pointerFilesMatch(left: GatewayTokenPointerFile, right: GatewayTokenPointerFile): boolean {
  return (
    left.vaultPath === right.vaultPath &&
    left.credentialRef === right.credentialRef &&
    left.masterKeyEnv === right.masterKeyEnv &&
    left.allowDerivedKeyFallback === right.allowDerivedKeyFallback
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseGatewayTokenPointer(raw: string): GatewayTokenPointerFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) {
    return undefined;
  }

  if (parsed.schema !== "brewva.gateway-token-pointer.v1") {
    return undefined;
  }

  const vaultPath = typeof parsed.vaultPath === "string" ? parsed.vaultPath.trim() : "";
  const credentialRef = typeof parsed.credentialRef === "string" ? parsed.credentialRef.trim() : "";
  const masterKeyEnv =
    typeof parsed.masterKeyEnv === "string" && parsed.masterKeyEnv.trim().length > 0
      ? parsed.masterKeyEnv.trim()
      : undefined;
  const allowDerivedKeyFallback =
    typeof parsed.allowDerivedKeyFallback === "boolean"
      ? parsed.allowDerivedKeyFallback
      : undefined;

  if (!vaultPath || !credentialRef) {
    return undefined;
  }

  return {
    schema: "brewva.gateway-token-pointer.v1",
    vaultPath,
    credentialRef,
    masterKeyEnv,
    allowDerivedKeyFallback,
  };
}

function looksLikeStructuredTokenFile(raw: string): boolean {
  const trimmed = raw.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function parseChildRegistryEntries(raw: unknown): ChildRegistryEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const entries: ChildRegistryEntry[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const candidate = row as Partial<ChildRegistryEntry>;
    if (
      typeof candidate.sessionId !== "string" ||
      typeof candidate.pid !== "number" ||
      typeof candidate.startedAt !== "number"
    ) {
      continue;
    }
    if (!candidate.sessionId.trim() || candidate.pid <= 0 || candidate.startedAt <= 0) {
      continue;
    }
    entries.push({
      sessionId: candidate.sessionId,
      pid: candidate.pid,
      startedAt: candidate.startedAt,
      agentSessionId:
        typeof candidate.agentSessionId === "string" && candidate.agentSessionId.trim().length > 0
          ? candidate.agentSessionId.trim()
          : undefined,
      agentEventLogPath:
        typeof candidate.agentEventLogPath === "string" &&
        candidate.agentEventLogPath.trim().length > 0
          ? candidate.agentEventLogPath.trim()
          : undefined,
      cwd:
        typeof candidate.cwd === "string" && candidate.cwd.trim().length > 0
          ? candidate.cwd
          : undefined,
    });
  }
  return entries;
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function writeJsonFileAtomically(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(value, null, 2), "utf8");
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // best effort
    }
    throw error;
  }
}

export class FileGatewayStateStore implements GatewayStateStore {
  private readonly tokenVault?: GatewayTokenVaultOptions;

  constructor(options?: { tokenVault?: GatewayTokenVaultOptions }) {
    this.tokenVault = options?.tokenVault
      ? {
          vaultPath: resolve(options.tokenVault.vaultPath),
          credentialRef: options.tokenVault.credentialRef,
          masterKeyEnv: options.tokenVault.masterKeyEnv,
          allowDerivedKeyFallback: options.tokenVault.allowDerivedKeyFallback,
        }
      : undefined;
  }

  private createVault(options: GatewayTokenVaultOptions): CredentialVaultService {
    return new CredentialVaultService({
      vaultPath: options.vaultPath,
      masterKeyEnv: options.masterKeyEnv,
      allowDerivedKeyFallback: options.allowDerivedKeyFallback,
    });
  }

  private buildTokenPointer(): GatewayTokenPointerFile | undefined {
    if (!this.tokenVault) {
      return undefined;
    }
    return {
      schema: "brewva.gateway-token-pointer.v1",
      vaultPath: this.tokenVault.vaultPath,
      credentialRef: this.tokenVault.credentialRef,
      masterKeyEnv: this.tokenVault.masterKeyEnv,
      allowDerivedKeyFallback: this.tokenVault.allowDerivedKeyFallback,
    };
  }

  readToken(tokenFilePath: string): string | undefined {
    const filePath = resolve(tokenFilePath);
    if (!existsSync(filePath)) {
      return undefined;
    }

    const raw = readFileSync(filePath, "utf8").trim();
    if (raw.length === 0) {
      return undefined;
    }
    const pointer = parseGatewayTokenPointer(raw);
    if (!pointer) {
      if (looksLikeStructuredTokenFile(raw)) {
        throw new Error(`Invalid gateway token pointer file: ${filePath}`);
      }
      return raw;
    }

    const value = this.createVault({
      vaultPath: pointer.vaultPath,
      credentialRef: pointer.credentialRef,
      masterKeyEnv: pointer.masterKeyEnv,
      allowDerivedKeyFallback: pointer.allowDerivedKeyFallback,
    }).get(pointer.credentialRef);
    if (!value) {
      throw new Error(
        `Gateway token pointer '${filePath}' did not resolve credential '${pointer.credentialRef}'.`,
      );
    }
    return value;
  }

  reconcileReadToken(tokenFilePath: string, token: string): void {
    const desiredPointer = this.buildTokenPointer();
    if (!desiredPointer) {
      return;
    }

    const filePath = resolve(tokenFilePath);
    if (!existsSync(filePath)) {
      return;
    }

    const raw = readFileSync(filePath, "utf8").trim();
    const existingPointer = raw.length > 0 ? parseGatewayTokenPointer(raw) : undefined;
    if (existingPointer && pointerFilesMatch(existingPointer, desiredPointer)) {
      return;
    }

    this.writeToken(filePath, token);
  }

  writeToken(tokenFilePath: string, token: string): void {
    const filePath = resolve(tokenFilePath);
    mkdirSync(dirname(filePath), { recursive: true });
    if (this.tokenVault) {
      const vault = this.createVault(this.tokenVault);
      vault.put(this.tokenVault.credentialRef, token);
      const pointer = this.buildTokenPointer();
      if (!pointer) {
        throw new Error("Gateway token vault pointer is unavailable.");
      }
      writeFileSync(filePath, `${JSON.stringify(pointer, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      return;
    }
    writeFileSync(filePath, `${token}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  readChildrenRegistry(registryPath: string): ChildRegistryEntry[] {
    const filePath = resolve(registryPath);
    if (!existsSync(filePath)) {
      return [];
    }
    return parseChildRegistryEntries(readJsonFile(filePath));
  }

  writeChildrenRegistry(registryPath: string, entries: ReadonlyArray<ChildRegistryEntry>): void {
    const filePath = resolve(registryPath);
    writeJsonFileAtomically(filePath, entries);
  }

  removeChildrenRegistry(registryPath: string): void {
    const filePath = resolve(registryPath);
    if (!existsSync(filePath)) {
      return;
    }
    try {
      rmSync(filePath, { force: true });
    } catch {
      // best effort
    }
  }
}
