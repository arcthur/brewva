import { Effect, Layer } from "effect";

export type BrewvaObservationValue = string | number | boolean | null | undefined;
export type BrewvaObservationFields = Readonly<Record<string, BrewvaObservationValue>>;

export function normalizeObservationFields(
  fields: BrewvaObservationFields | undefined,
): Record<string, string | number | boolean> {
  const normalized: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === undefined || value === null) {
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}

export function withBrewvaSpan(name: string, attributes?: BrewvaObservationFields) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.withSpan(effect, name, {
      attributes: normalizeObservationFields(attributes),
    }) as Effect.Effect<A, E, R>;
}

export function annotateBrewvaLogs(fields?: BrewvaObservationFields) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    const annotations = normalizeObservationFields(fields);
    if (Object.keys(annotations).length === 0) {
      return effect;
    }
    return Effect.annotateLogs(effect, annotations);
  };
}

export function withBrewvaObservability(name: string, fields?: BrewvaObservationFields) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(annotateBrewvaLogs(fields), withBrewvaSpan(name, fields));
}

export interface BrewvaObservabilityConfig {
  enabled?: boolean;
  serviceName?: string;
  serviceVersion?: string;
  attributes?: Readonly<Record<string, string | number | boolean>>;
  nodeSdk?: Omit<BrewvaNodeSdkConfiguration, "resource">;
}

export interface BrewvaNodeSdkResource {
  readonly serviceName?: string;
  readonly serviceVersion?: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface BrewvaNodeSdkConfiguration {
  readonly spanProcessor?: unknown;
  readonly metricReader?: unknown;
  readonly logRecordProcessor?: unknown;
  readonly resource?: BrewvaNodeSdkResource;
  readonly [key: string]: unknown;
}

export interface BrewvaObservabilityLayerOptions {
  readonly makeNodeSdkLayer?: (
    config: BrewvaNodeSdkConfiguration,
  ) => Layer.Layer<never> | Promise<Layer.Layer<never>>;
}

function shouldBuildNodeSdkLayer(config: BrewvaObservabilityConfig): boolean {
  return (
    config.enabled === true ||
    config.nodeSdk?.spanProcessor !== undefined ||
    config.nodeSdk?.metricReader !== undefined ||
    config.nodeSdk?.logRecordProcessor !== undefined
  );
}

function toNodeSdkConfiguration(config: BrewvaObservabilityConfig): BrewvaNodeSdkConfiguration {
  return {
    ...config.nodeSdk,
    resource: config.serviceName
      ? {
          serviceName: config.serviceName,
          serviceVersion: config.serviceVersion,
          attributes: config.attributes,
        }
      : undefined,
  };
}

function isPromiseLike<A>(value: A | Promise<A>): value is Promise<A> {
  return typeof (value as { readonly then?: unknown }).then === "function";
}

export function observabilityLayer(
  evaluate: () => BrewvaObservabilityConfig = () => ({}),
  options: BrewvaObservabilityLayerOptions = {},
): Layer.Layer<never> {
  return Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* Effect.sync(evaluate);
      if (!shouldBuildNodeSdkLayer(config)) {
        return Layer.empty;
      }
      if (!options.makeNodeSdkLayer) {
        return yield* Effect.die(
          new Error(
            "Brewva observability requires an explicit Node SDK layer factory when enabled.",
          ),
        );
      }
      const layer = yield* Effect.sync(() =>
        options.makeNodeSdkLayer!(toNodeSdkConfiguration(config)),
      );
      if (isPromiseLike(layer)) {
        return yield* Effect.promise(() => layer);
      }
      return layer;
    }).pipe(Effect.orDie),
  );
}

export const emptyObservabilityLayer: Layer.Layer<never> = Layer.empty;
