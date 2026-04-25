import type {
  BoxExecResult,
  BoxNetworkCapability,
  BoxPlaneOptions,
  BoxScope,
} from "../contract.js";
import { BoxPlaneError } from "../errors.js";
import { readRecord } from "../internal/guards.js";
import type { BoxLiteRuntime } from "./runtime.js";

export interface NativeSnapshotManager {
  create?: (name: string) => Promise<unknown>;
  restore?: (name: string) => Promise<void>;
  list?: () => Promise<unknown[]>;
  get?: (name: string) => Promise<unknown>;
  remove?: (name: string) => Promise<void>;
}

export interface NativeBox {
  id?: string;
  boxId?: string;
  exec?: (
    command: string,
    args: string[],
    env?: Array<[string, string]>,
    tty?: boolean,
    user?: string,
    timeoutSec?: number,
    cwd?: string,
  ) => Promise<unknown>;
  snapshot?: NativeSnapshotManager;
  cloneBox?: (name: string) => Promise<unknown>;
  start?: () => Promise<void>;
  stop?: () => Promise<void>;
}

export async function createNativeBox(
  runtime: BoxLiteRuntime,
  options: BoxPlaneOptions,
  scope: BoxScope,
  fingerprint: string,
): Promise<NativeBox> {
  const volumes = [
    {
      hostPath: scope.workspaceRoot,
      guestPath: options.workspaceGuestPath,
      readOnly: false,
    },
    ...scope.capabilities.extraVolumes.map(({ readonly: readOnly, ...volume }) => ({
      ...volume,
      readOnly,
    })),
  ];
  if (scope.capabilities.secrets.length > 0) {
    throw new BoxPlaneError(
      "BoxLite native adapter does not yet support direct secret injection",
      "box_capability_unsupported",
      { capability: "secrets" },
    );
  }
  const nativeOptions = {
    image: scope.image || options.image,
    cpus: options.cpus,
    memoryMib: options.memoryMib,
    diskSizeGb: options.diskGb,
    workingDir: options.workspaceGuestPath,
    volumes,
    network: toNativeNetworkMode(scope.capabilities.network),
    ports: scope.capabilities.ports.map(({ guest, host, protocol }) => ({
      guestPort: guest,
      hostPort: host,
      protocol,
    })),
    autoRemove: false,
    detach: options.detach,
  };
  const name = `brewva-${fingerprint.slice(0, 32)}`;
  if (runtime.getOrCreate) {
    const result = await runtime.getOrCreate(nativeOptions, name);
    const record = readRecord(result);
    return asNativeBox(record?.box ?? result);
  }
  if (runtime.create) {
    return asNativeBox(await runtime.create(nativeOptions, name));
  }
  throw new BoxPlaneError("BoxLite runtime does not expose create()", "boxlite_sdk_unavailable");
}

export function readNativeId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    ? record.id
    : typeof record.boxId === "string"
      ? record.boxId
      : undefined;
}

export async function collectNativeExecResult(
  id: string,
  boxId: string,
  result: unknown,
): Promise<BoxExecResult> {
  if (isNativeExecution(result)) {
    const [stdout, stderr, waitResult] = await Promise.all([
      readNativeStream(() => result.stdout()),
      readNativeStream(() => result.stderr()),
      result.wait(),
    ]);
    return {
      id,
      boxId,
      stdout,
      stderr,
      exitCode: readExitCode(waitResult),
    };
  }
  if (!result || typeof result !== "object") {
    return { id, boxId, stdout: "", stderr: "", exitCode: 0 };
  }
  const record = result as Record<string, unknown>;
  return {
    id,
    boxId,
    stdout: typeof record.stdout === "string" ? record.stdout : "",
    stderr: typeof record.stderr === "string" ? record.stderr : "",
    exitCode: typeof record.exitCode === "number" ? record.exitCode : 0,
  };
}

export async function killNativeExecution(value: unknown, signal: string): Promise<void> {
  const record = readRecord(value);
  if (typeof record?.kill === "function") {
    await record.kill(signal);
  }
}

export function asNativeBox(value: unknown): NativeBox {
  const record = readRecord(value);
  if (!record) {
    throw new BoxPlaneError("Unsupported BoxLite box object", "boxlite_sdk_unavailable");
  }
  return {
    id: typeof record.id === "string" ? record.id : undefined,
    boxId: typeof record.boxId === "string" ? record.boxId : undefined,
    exec:
      typeof record.exec === "function"
        ? (record.exec.bind(value) as NativeBox["exec"])
        : undefined,
    snapshot: asNativeSnapshotManager(record.snapshot),
    cloneBox:
      typeof record.cloneBox === "function"
        ? (record.cloneBox.bind(value) as NativeBox["cloneBox"])
        : undefined,
    start:
      typeof record.start === "function"
        ? (record.start.bind(value) as NativeBox["start"])
        : undefined,
    stop:
      typeof record.stop === "function"
        ? (record.stop.bind(value) as NativeBox["stop"])
        : undefined,
  };
}

function toNativeNetworkMode(network: BoxNetworkCapability): string {
  if (network.mode === "off") {
    return "isolated";
  }
  if (network.allow.length === 0) {
    return "isolated";
  }
  throw new BoxPlaneError(
    "BoxLite native adapter cannot enforce domain allowlists with the current Node SDK",
    "box_capability_unsupported",
    { capability: "network.allowlist" },
  );
}

function isNativeExecution(value: unknown): value is {
  stdout(): Promise<{ next(): Promise<string | null> }>;
  stderr(): Promise<{ next(): Promise<string | null> }>;
  wait(): Promise<unknown>;
} {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.stdout === "function" &&
    typeof record.stderr === "function" &&
    typeof record.wait === "function"
  );
}

async function readNativeStream(
  getStream: () => Promise<{ next(): Promise<string | null> }>,
): Promise<string> {
  try {
    const stream = await getStream();
    const chunks: string[] = [];
    while (true) {
      const chunk = await stream.next();
      if (chunk === null) break;
      chunks.push(chunk);
    }
    return chunks.join("");
  } catch {
    return "";
  }
}

function readExitCode(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  return typeof record.exitCode === "number" ? record.exitCode : 0;
}

function asNativeSnapshotManager(value: unknown): NativeSnapshotManager | undefined {
  const record = readRecord(value);
  if (!record) return undefined;
  return {
    create:
      typeof record.create === "function"
        ? (record.create.bind(value) as NativeSnapshotManager["create"])
        : undefined,
    restore:
      typeof record.restore === "function"
        ? (record.restore.bind(value) as NativeSnapshotManager["restore"])
        : undefined,
    list:
      typeof record.list === "function"
        ? (record.list.bind(value) as NativeSnapshotManager["list"])
        : undefined,
    get:
      typeof record.get === "function"
        ? (record.get.bind(value) as NativeSnapshotManager["get"])
        : undefined,
    remove:
      typeof record.remove === "function"
        ? (record.remove.bind(value) as NativeSnapshotManager["remove"])
        : undefined,
  };
}
