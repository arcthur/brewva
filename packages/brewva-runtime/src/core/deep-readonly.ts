export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends string | number | boolean | bigint | symbol | null | undefined
    ? T
    : T extends readonly (infer TValue)[]
      ? readonly DeepReadonly<TValue>[]
      : T extends object
        ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
        : T;
