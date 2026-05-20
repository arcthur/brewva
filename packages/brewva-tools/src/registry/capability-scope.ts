import { attachRuntimeSourceIdentity } from "@brewva/brewva-std/runtime-identity";
import type { BrewvaToolRuntime } from "../contracts/index.js";
import { getBrewvaToolRequiredCapabilities } from "./required-capabilities.js";
import { isBrewvaToolRuntimeCapabilityPath } from "./runtime-capability-inventory.js";

function assertRequiredCapabilitiesInInventory(
  toolName: string,
  capabilities: readonly string[],
): void {
  const invalid = capabilities.filter(
    (capability) => !isBrewvaToolRuntimeCapabilityPath(capability),
  );
  if (invalid.length === 0) {
    return;
  }
  throw new Error(
    `managed Brewva tool '${toolName}' declared unknown runtime capability '${invalid.join(", ")}'.`,
  );
}

function bindScopedMethod(
  toolName: string,
  capability: string,
  allowedCapabilities: ReadonlySet<string>,
  target: object,
  value: unknown,
): unknown {
  if (typeof value !== "function") {
    return value;
  }
  if (allowedCapabilities.has(capability)) {
    return value.bind(target);
  }
  return (..._args: unknown[]) => {
    throw new Error(
      `managed Brewva tool '${toolName}' attempted to access protected runtime capability '${capability}' without declaring it.`,
    );
  };
}

function createScopedRuntimePort<TPort extends object>(
  toolName: string,
  port: TPort,
  capabilityPrefix: string,
  allowedCapabilities: ReadonlySet<string>,
): TPort {
  return new Proxy(port, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== "string") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      const capability = `${capabilityPrefix}.${property}`;
      if (value && typeof value === "object") {
        return createScopedRuntimePort(toolName, value, capability, allowedCapabilities);
      }
      return bindScopedMethod(toolName, capability, allowedCapabilities, target, value);
    },
  });
}

function createScopedRoot<TGroup extends object>(
  toolName: string,
  group: TGroup,
  capabilityPrefix: "capabilities",
  allowedCapabilities: ReadonlySet<string>,
): TGroup {
  return createScopedRuntimePort(toolName, group, capabilityPrefix, allowedCapabilities);
}

export function createCapabilityScopedToolRuntime<T extends BrewvaToolRuntime>(
  runtime: T,
  toolName: string,
): T {
  const allowedCapabilities = new Set<string>(getBrewvaToolRequiredCapabilities(toolName));
  assertRequiredCapabilitiesInInventory(toolName, [...allowedCapabilities]);
  let changed = false;
  let capabilities = runtime.capabilities;
  let extensions = runtime.extensions;

  if (runtime.capabilities && typeof runtime.capabilities === "object") {
    const scopedCapabilities = createScopedRoot(
      toolName,
      runtime.capabilities,
      "capabilities",
      allowedCapabilities,
    );
    if (scopedCapabilities !== runtime.capabilities) {
      capabilities = scopedCapabilities;
      changed = true;
    }
  }

  if (runtime.extensions?.tools && typeof runtime.extensions.tools === "object") {
    const scopedToolsExtension = createScopedRuntimePort(
      toolName,
      runtime.extensions.tools,
      "extensions.tools",
      allowedCapabilities,
    );
    if (scopedToolsExtension !== runtime.extensions.tools) {
      extensions = {
        ...runtime.extensions,
        tools: scopedToolsExtension,
      };
      changed = true;
    }
  }

  if (!changed) {
    return runtime;
  }
  return attachRuntimeSourceIdentity(
    {
      ...runtime,
      capabilities,
      ...(extensions ? { extensions } : {}),
    },
    runtime,
  );
}
