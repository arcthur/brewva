import { BrewvaEffect, type BrewvaRunOptions } from "@brewva/brewva-effect";
import type { RuntimeEffectServices } from "./runtime/effect-runtime-layer.js";
import {
  getRuntimeEffectLayer as getRuntimeFacadeEffectLayer,
  getRuntimeEffectSpine as getRuntimeFacadeEffectSpine,
  type RuntimeFacadeControllerHandle,
} from "./runtime/runtime-facade-state.js";

export type RuntimeEffectHost = RuntimeFacadeControllerHandle;

export function getRuntimeEffectLayer(
  runtime: RuntimeEffectHost,
): ReturnType<typeof getRuntimeFacadeEffectLayer> {
  return getRuntimeFacadeEffectLayer(runtime);
}

export function getRuntimeEffectSpine(
  runtime: RuntimeEffectHost,
): ReturnType<typeof getRuntimeFacadeEffectSpine> {
  return getRuntimeFacadeEffectSpine(runtime);
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
