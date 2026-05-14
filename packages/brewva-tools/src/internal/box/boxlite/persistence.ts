import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BoxScope } from "../contract.js";
import { BoxPlaneError } from "../errors.js";
import { isNodeError, readRecord } from "../internal/guards.js";
import type { PersistedBoxPlaneIndex, StoredBox } from "../plane/stored-box.js";
import { normalizeBoxCapabilitySet } from "../scope.js";

export async function loadPersistedBoxIndex(indexPath: string): Promise<StoredBox[]> {
  try {
    const content = await readFile(indexPath, "utf8");
    const parsed = JSON.parse(content) as Partial<PersistedBoxPlaneIndex>;
    if (parsed.version !== 1 || !Array.isArray(parsed.boxes)) return [];
    const boxes: StoredBox[] = [];
    for (const box of parsed.boxes) {
      if (!isPersistedBox(box)) continue;
      boxes.push({
        ...box,
        scope: {
          ...box.scope,
          capabilities: normalizeBoxCapabilitySet(box.scope.capabilities),
        },
        runningExecCount: 0,
      });
    }
    return boxes;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw new BoxPlaneError("Unable to load Brewva box plane index", "box_unavailable", {
      path: indexPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function persistBoxIndex(
  indexPath: string,
  boxes: Iterable<StoredBox>,
): Promise<void> {
  const payload: PersistedBoxPlaneIndex = {
    version: 1,
    boxes: [...boxes].map(
      ({ native: _native, runningExecCount: _runningExecCount, ...box }) => box,
    ),
  };
  await mkdir(dirname(indexPath), { recursive: true });
  const tempPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempPath, indexPath);
}

function isPersistedBox(value: unknown): value is Omit<StoredBox, "native" | "runningExecCount"> {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.fingerprint === "string" &&
    (record.createReason === "created" ||
      record.createReason === "capability_changed" ||
      record.createReason === "workspace_root_changed" ||
      record.createReason === "recovered") &&
    typeof record.createdAt === "string" &&
    isPersistedScope(record.scope) &&
    Array.isArray(record.snapshots)
  );
}

function isPersistedScope(value: unknown): value is BoxScope {
  const record = readRecord(value);
  if (!record) return false;
  const capabilities = readRecord(record.capabilities);
  return (
    (record.kind === "session" || record.kind === "task" || record.kind === "ephemeral") &&
    typeof record.id === "string" &&
    typeof record.image === "string" &&
    typeof record.workspaceRoot === "string" &&
    Boolean(capabilities) &&
    typeof capabilities?.network === "object" &&
    typeof capabilities.gpu === "boolean" &&
    Array.isArray(capabilities.extraVolumes) &&
    Array.isArray(capabilities.secrets) &&
    Array.isArray(capabilities.ports)
  );
}
