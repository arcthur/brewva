import { BrewvaEffect, type BrewvaRunOptions } from "@brewva/brewva-effect";
import type { RuntimeEffectServices } from "./runtime/effect-runtime-layer.js";
import {
  BREWVA_RUNTIME_INTERNAL_STATE_SYMBOL,
  getRuntimeEffectLayer as getRuntimeFacadeEffectLayer,
  getRuntimeEffectSpine as getRuntimeFacadeEffectSpine,
  type RuntimeFacadeState,
} from "./runtime/runtime-facade-state.js";
import type { BrewvaRuntime } from "./runtime/runtime.js";

type RuntimeEffectHost = BrewvaRuntime | RuntimeFacadeState;

function asRuntimeFacadeState(runtime: RuntimeEffectHost): RuntimeFacadeState {
  if (!(BREWVA_RUNTIME_INTERNAL_STATE_SYMBOL in runtime)) {
    throw new Error("runtime does not expose Brewva internal Effect state");
  }
  return runtime;
}

export function getRuntimeEffectLayer(
  runtime: RuntimeEffectHost,
): ReturnType<typeof getRuntimeFacadeEffectLayer> {
  return getRuntimeFacadeEffectLayer(asRuntimeFacadeState(runtime));
}

export function getRuntimeEffectSpine(
  runtime: RuntimeEffectHost,
): ReturnType<typeof getRuntimeFacadeEffectSpine> {
  return getRuntimeFacadeEffectSpine(asRuntimeFacadeState(runtime));
}

export function runRuntimeEffect<A, E>(
  runtime: RuntimeEffectHost,
  effect: BrewvaEffect.Effect<A, E, RuntimeEffectServices>,
  options?: BrewvaRunOptions,
): Promise<A> {
  return getRuntimeEffectSpine(runtime).runPromise(effect, options);
}

export function runRuntimeEffectSync<A, E>(
  runtime: RuntimeEffectHost,
  effect: BrewvaEffect.Effect<A, E, RuntimeEffectServices>,
): A {
  return getRuntimeEffectSpine(runtime).runSync(effect);
}

export {
  RuntimeConfigService,
  RuntimeCoreDependenciesService,
  RuntimeBuildConfigService,
  RuntimeCompositionHooksService,
  RuntimeIdentityService,
  RuntimeInfrastructureConfigService,
  RuntimeKernelService,
  RuntimeLazyServiceFactoriesService,
  RuntimeScheduleConfigService,
  RuntimeSecurityConfigService,
  RuntimeServiceDependenciesService,
  buildRuntimeEffectServices,
  collectRuntimeComposition,
  createRuntimeEffectLayer,
  createRuntimeEffectLayerInput,
  createRuntimeEffectSpine,
} from "./runtime/effect-runtime-layer.js";
export type {
  RuntimeBuildConfigShape,
  RuntimeCompositionHooksShape,
  RuntimeConfigShape,
  RuntimeEffectLayerInput,
  RuntimeEffectSpine,
  RuntimeEffectServices,
  RuntimeIdentityShape,
} from "./runtime/effect-runtime-layer.js";
