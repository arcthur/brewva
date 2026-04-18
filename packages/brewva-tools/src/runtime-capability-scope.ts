import { getBrewvaToolRequiredCapabilities } from "./required-capabilities.js";
import type { BrewvaToolRuntime } from "./types.js";

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

function createScopedMethodPort<TPort extends object>(
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
      return bindScopedMethod(toolName, capability, allowedCapabilities, target, value);
    },
  });
}

function createScopedNestedGroup<TGroup extends object>(
  toolName: string,
  group: TGroup,
  capabilityPrefix: "authority" | "inspect",
  allowedCapabilities: ReadonlySet<string>,
): TGroup {
  let changed = false;
  const nextGroup = { ...group };

  for (const portName of Object.keys(group)) {
    const port = Reflect.get(group, portName);
    if (!port || typeof port !== "object") {
      continue;
    }
    Reflect.set(
      nextGroup,
      portName,
      createScopedMethodPort(
        toolName,
        port,
        `${capabilityPrefix}.${portName}`,
        allowedCapabilities,
      ),
    );
    changed = true;
  }

  return changed ? nextGroup : group;
}

export function createCapabilityScopedToolRuntime<T extends BrewvaToolRuntime>(
  runtime: T,
  toolName: string,
): T {
  const allowedCapabilities = new Set<string>(getBrewvaToolRequiredCapabilities(toolName));
  let changed = false;
  let authority = runtime.authority;
  let inspect = runtime.inspect;
  let internal = runtime.internal;

  if (runtime.authority && typeof runtime.authority === "object") {
    const scopedAuthority = createScopedNestedGroup(
      toolName,
      runtime.authority,
      "authority",
      allowedCapabilities,
    );
    if (scopedAuthority !== runtime.authority) {
      authority = scopedAuthority;
      changed = true;
    }
  }

  if (runtime.inspect && typeof runtime.inspect === "object") {
    const scopedInspect = createScopedNestedGroup(
      toolName,
      runtime.inspect,
      "inspect",
      allowedCapabilities,
    );
    if (scopedInspect !== runtime.inspect) {
      inspect = scopedInspect;
      changed = true;
    }
  }

  if (runtime.internal && typeof runtime.internal === "object") {
    const scopedInternal = createScopedMethodPort(
      toolName,
      runtime.internal,
      "internal",
      allowedCapabilities,
    );
    if (scopedInternal !== runtime.internal) {
      internal = scopedInternal;
      changed = true;
    }
  }

  if (!changed) {
    return runtime;
  }
  return {
    ...runtime,
    authority,
    inspect,
    ...(internal ? { internal } : {}),
  };
}
