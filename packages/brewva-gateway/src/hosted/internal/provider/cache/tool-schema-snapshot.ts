import { redactedStableJsonSha256Hex } from "@brewva/brewva-std/hash";

export interface ToolSchemaSnapshotTool {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ToolSchemaSnapshot {
  hash: string;
  overlayHash: string;
  perToolHashes: Record<string, string>;
  tools: ToolSchemaSnapshotTool[];
  epoch: number;
  invalidationReason: string;
  driftedToolNames: string[];
}

export interface ToolSchemaSnapshotStore {
  resolve(tools: ToolSchemaSnapshotTool[], invalidationReason: string): ToolSchemaSnapshot;
  clear(invalidationReason?: string): void;
}

interface SnapshotBuildOptions {
  epoch?: number;
  invalidationReason?: string;
  overlayTools?: ToolSchemaSnapshotTool[];
  driftedToolNames?: string[];
}

export function createToolSchemaSnapshot(
  tools: ToolSchemaSnapshotTool[],
  options: SnapshotBuildOptions = {},
): ToolSchemaSnapshot {
  const normalizedTools = tools
    .map(normalizeTool)
    .toSorted((left, right) => left.name.localeCompare(right.name));
  const overlayTools = (options.overlayTools ?? normalizedTools)
    .map(normalizeTool)
    .toSorted((left, right) => left.name.localeCompare(right.name));
  const perToolHashes: Record<string, string> = {};
  for (const tool of normalizedTools) {
    perToolHashes[tool.name] = redactedStableJsonSha256Hex(tool);
  }
  return {
    hash: redactedStableJsonSha256Hex(normalizedTools),
    overlayHash: redactedStableJsonSha256Hex(overlayTools),
    perToolHashes,
    tools: normalizedTools,
    epoch: Math.max(0, Math.trunc(options.epoch ?? 0)),
    invalidationReason: options.invalidationReason ?? "initial",
    driftedToolNames: (options.driftedToolNames ?? []).toSorted(),
  };
}

export function createToolSchemaSnapshotStore(): ToolSchemaSnapshotStore {
  let lockedSnapshot: ToolSchemaSnapshot | undefined;
  let epoch = 0;
  let lastClearReason = "initial";

  return {
    resolve(tools, invalidationReason) {
      const normalizedTools = tools
        .map(normalizeTool)
        .toSorted((left, right) => left.name.localeCompare(right.name));
      if (!lockedSnapshot) {
        lockedSnapshot = createToolSchemaSnapshot(normalizedTools, {
          epoch,
          invalidationReason: lastClearReason === "initial" ? invalidationReason : lastClearReason,
        });
        return lockedSnapshot;
      }

      if (!sameToolNameSet(lockedSnapshot.tools, normalizedTools)) {
        epoch += 1;
        lockedSnapshot = createToolSchemaSnapshot(normalizedTools, {
          epoch,
          invalidationReason,
        });
        return lockedSnapshot;
      }

      const overlayHash = redactedStableJsonSha256Hex(normalizedTools);
      const driftedToolNames = findDriftedToolNames(lockedSnapshot, normalizedTools);
      return {
        ...lockedSnapshot,
        overlayHash,
        driftedToolNames,
      };
    },
    clear(invalidationReason = "clear") {
      lockedSnapshot = undefined;
      epoch += 1;
      lastClearReason = invalidationReason;
    },
  };
}

function normalizeTool(tool: ToolSchemaSnapshotTool): ToolSchemaSnapshotTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

function sameToolNameSet(
  left: readonly ToolSchemaSnapshotTool[],
  right: readonly ToolSchemaSnapshotTool[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.name !== right[index]?.name) {
      return false;
    }
  }
  return true;
}

function findDriftedToolNames(
  lockedSnapshot: ToolSchemaSnapshot,
  overlayTools: readonly ToolSchemaSnapshotTool[],
): string[] {
  const drifted: string[] = [];
  for (const tool of overlayTools) {
    const lockedHash = lockedSnapshot.perToolHashes[tool.name];
    const overlayHash = redactedStableJsonSha256Hex(tool);
    if (lockedHash !== overlayHash) {
      drifted.push(tool.name);
    }
  }
  return drifted.toSorted();
}
