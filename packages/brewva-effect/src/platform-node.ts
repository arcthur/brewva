import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import type { Layer } from "effect";
import type { BrewvaNodeSdkConfiguration } from "./observability.js";

export {
  NodeChildProcessSpawner as BrewvaNodeChildProcessSpawner,
  NodeFileSystem as BrewvaNodeFileSystem,
  NodePath as BrewvaNodePath,
  NodeRuntime as BrewvaNodeRuntime,
};

export const nodeFileSystemLayer = NodeFileSystem.layer;

export async function loadNodeOpenTelemetryLayer(
  config: BrewvaNodeSdkConfiguration,
): Promise<Layer.Layer<never>> {
  const { NodeSdk } = await import("@effect/opentelemetry");
  return NodeSdk.layer(() => config as never) as Layer.Layer<never>;
}
