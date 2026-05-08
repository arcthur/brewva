const RUNTIME_SOURCE_IDENTITY = Symbol.for("@brewva/brewva-std/runtime-source-identity");

export interface RuntimeSourceIdentityCarrier {
  readonly [RUNTIME_SOURCE_IDENTITY]?: object;
}

export function attachRuntimeSourceIdentity<T extends object>(runtime: T, source: object): T {
  Object.defineProperty(runtime, RUNTIME_SOURCE_IDENTITY, {
    value: resolveRuntimeSourceIdentity(source),
    enumerable: false,
    configurable: false,
  });
  return runtime;
}

export function resolveRuntimeSourceIdentity(runtime: object): object {
  return (runtime as RuntimeSourceIdentityCarrier)[RUNTIME_SOURCE_IDENTITY] ?? runtime;
}
