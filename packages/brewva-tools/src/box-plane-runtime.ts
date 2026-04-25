import { createHash } from "node:crypto";
import { createBoxPlane, type BoxPlane, type BoxPlaneOptions } from "@brewva/brewva-box";
import { stableStringify } from "@brewva/brewva-box/internal/stable-json";
import {
  BOX_RELEASED_EVENT_TYPE,
  DEFAULT_BREWVA_CONFIG,
  resolvePathInput,
  type BrewvaConfig,
} from "@brewva/brewva-runtime";
import type { BrewvaBundledToolRuntime } from "./types.js";

export type RuntimeBoxConfig = BrewvaConfig["security"]["execution"]["box"];

interface CachedBoxPlane {
  readonly cacheKey: string;
  readonly plane: BoxPlane;
}

const boxPlaneByHome = new Map<string, CachedBoxPlane>();
const runtimeHookRegistrations = new WeakMap<object, Set<BoxPlane>>();

export function resolveRuntimeBoxConfig(runtime?: BrewvaBundledToolRuntime): RuntimeBoxConfig {
  const box =
    runtime?.config?.security.execution.box ?? DEFAULT_BREWVA_CONFIG.security.execution.box;
  return cloneBoxConfig(box as RuntimeBoxConfig);
}

export function cloneBoxConfig(box: RuntimeBoxConfig): RuntimeBoxConfig {
  return {
    ...box,
    home: resolvePathInput(process.cwd(), box.home),
    network:
      box.network.mode === "allowlist"
        ? { mode: "allowlist", allow: [...box.network.allow] }
        : { mode: "off" },
    gc: { ...box.gc },
  };
}

export function resolveConfiguredBoxPlane(
  runtime: BrewvaBundledToolRuntime | undefined,
  box: RuntimeBoxConfig,
): BoxPlane {
  if (runtime?.boxPlane) {
    registerRuntimeBoxPlaneHooks(runtime, runtime.boxPlane);
    return runtime.boxPlane;
  }
  const cacheKey = hashBoxConfig(box);
  const cached = boxPlaneByHome.get(box.home);
  if (cached) {
    if (cached.cacheKey !== cacheKey) {
      throw new Error(
        `Box plane home '${box.home}' is already bound to a different execution box configuration. Use a distinct security.execution.box.home for different image/resource/network settings.`,
      );
    }
    registerRuntimeBoxPlaneHooks(runtime, cached.plane);
    return cached.plane;
  }
  const options: BoxPlaneOptions = {
    home: box.home,
    image: box.image,
    cpus: box.cpus,
    memoryMib: box.memoryMib,
    diskGb: box.diskGb,
    workspaceGuestPath: box.workspaceGuestPath,
    network: box.network,
    detach: box.detach,
    autoSnapshotOnRelease: box.autoSnapshotOnRelease,
    perSessionLifetime: box.perSessionLifetime,
    gc: { ...box.gc },
  };
  const plane = createBoxPlane(options);
  boxPlaneByHome.set(box.home, { cacheKey, plane });
  registerRuntimeBoxPlaneHooks(runtime, plane);
  return plane;
}

function registerRuntimeBoxPlaneHooks(
  runtime: BrewvaBundledToolRuntime | undefined,
  plane: BoxPlane,
): void {
  if (!runtime?.internal?.onClearState) return;
  const runtimeKey = runtime as object;
  let planes = runtimeHookRegistrations.get(runtimeKey);
  if (!planes) {
    planes = new Set();
    runtimeHookRegistrations.set(runtimeKey, planes);
  }
  if (planes.has(plane)) return;
  planes.add(plane);
  runtime.internal.onClearState((sessionId) => {
    void releaseSessionBoxes(runtime, plane, sessionId).catch(() => {});
  });
}

async function releaseSessionBoxes(
  runtime: BrewvaBundledToolRuntime,
  plane: BoxPlane,
  sessionId: string,
): Promise<void> {
  const inventory = await plane.inspect();
  const matchingBoxes = inventory.boxes.filter(
    (box) => box.scope.kind === "session" && box.scope.id === sessionId,
  );
  await plane.releaseScope({ kind: "session", id: sessionId }, "session_closed");
  for (const box of matchingBoxes) {
    runtime.internal?.recordEvent?.({
      sessionId,
      type: BOX_RELEASED_EVENT_TYPE,
      payload: {
        boxId: box.id,
        fingerprint: box.fingerprint,
        scopeKind: box.scope.kind,
        scopeId: box.scope.id,
        reason: "session_closed",
      },
    });
  }
}

function hashBoxConfig(box: RuntimeBoxConfig): string {
  return createHash("sha256")
    .update(stableStringify(cloneBoxConfig(box)))
    .digest("hex");
}
