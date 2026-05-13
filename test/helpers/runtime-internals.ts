import type { BrewvaRuntimeInstance, BrewvaRuntimeOptions } from "@brewva/brewva-runtime";
import { createBrewvaRuntimeAssemblyForInternalUse } from "../../packages/brewva-runtime/src/runtime/runtime.js";

export function createRuntimeWithInternals(options: BrewvaRuntimeOptions = {}): {
  readonly runtimeInstance: BrewvaRuntimeInstance;
  readonly internals: unknown;
} {
  const assembly = createBrewvaRuntimeAssemblyForInternalUse(options);
  return {
    runtimeInstance: assembly.instance,
    internals: assembly.controller,
  };
}
