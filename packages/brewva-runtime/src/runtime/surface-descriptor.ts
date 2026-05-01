export type RuntimeSemanticSurfaceName = "authority" | "inspect" | "maintain";

export type SurfaceContribution<TMethods extends object> = Partial<{
  readonly [TSurface in RuntimeSemanticSurfaceName]: readonly (keyof TMethods)[];
}>;

export interface RuntimeSurfaceModule<
  TName extends string,
  TDependencies,
  TMethods extends object,
  TContribution extends SurfaceContribution<TMethods>,
> {
  readonly name: TName;
  createMethods(dependencies: TDependencies): TMethods;
  readonly contribution: TContribution;
}

type SurfaceKeys<TMethods extends object> = readonly (keyof TMethods)[];

type BoundSurfaceMethods<TMethods extends object, TKeys extends SurfaceKeys<TMethods>> = Pick<
  TMethods,
  TKeys[number]
>;

export type BoundSurfaceContribution<
  TMethods extends object,
  TContribution extends SurfaceContribution<TMethods>,
> = {
  readonly [TSurface in keyof TContribution]: TContribution[TSurface] extends SurfaceKeys<TMethods>
    ? BoundSurfaceMethods<TMethods, TContribution[TSurface]>
    : never;
};

export function defineRuntimeSurfaceModule<
  TName extends string,
  TDependencies,
  TMethods extends object,
  const TContribution extends SurfaceContribution<TMethods>,
>(
  input: RuntimeSurfaceModule<TName, TDependencies, TMethods, TContribution>,
): RuntimeSurfaceModule<TName, TDependencies, TMethods, TContribution> {
  return input;
}

export function bindMethods<TObject extends object, const TKeys extends readonly (keyof TObject)[]>(
  owner: TObject,
  keys: TKeys,
): Pick<TObject, TKeys[number]> {
  const result = {} as Pick<TObject, TKeys[number]>;
  for (const key of keys) {
    const value = owner[key];
    if (typeof value !== "function") {
      throw new Error(`Expected method at key ${String(key)}`);
    }
    (result as Record<keyof TObject, unknown>)[key] = value.bind(owner);
  }
  return result;
}

export function bindSurfaceContribution<
  TMethods extends object,
  const TContribution extends SurfaceContribution<TMethods>,
>(
  methods: TMethods,
  contribution: TContribution,
): BoundSurfaceContribution<TMethods, TContribution> {
  const result = {} as Record<keyof TContribution, unknown>;
  for (const [surfaceName, keys] of Object.entries(contribution) as [
    keyof TContribution,
    TContribution[keyof TContribution],
  ][]) {
    if (!keys) {
      continue;
    }
    result[surfaceName] = bindMethods(
      methods,
      keys as SurfaceKeys<TMethods>,
    ) as BoundSurfaceContribution<TMethods, TContribution>[typeof surfaceName];
  }
  return result as BoundSurfaceContribution<TMethods, TContribution>;
}
