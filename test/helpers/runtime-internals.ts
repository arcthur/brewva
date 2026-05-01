import type { BrewvaRuntime } from "@brewva/brewva-runtime";

const BREWVA_RUNTIME_INTERNAL_STATE_SYMBOL = Symbol.for("brewva.runtime.internal-state");

export function getRuntimeInternals(runtime: BrewvaRuntime): unknown {
  const internals = (runtime as unknown as Record<PropertyKey, unknown>)[
    BREWVA_RUNTIME_INTERNAL_STATE_SYMBOL
  ];
  if (!internals) {
    throw new Error("brewva_runtime_internal_state_unavailable");
  }
  return internals;
}
