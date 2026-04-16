export type VerificationLevel = "quick" | "standard" | "strict";

export type RuntimeSuccess<T extends Record<string, unknown> = {}> = { ok: true } & T;
export type RuntimeFailure<E extends string = string> = { ok: false; error: E };
export type RuntimeResult<T extends Record<string, unknown> = {}, E extends string = string> =
  | RuntimeSuccess<T>
  | RuntimeFailure<E>;

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer TValue)[]
    ? readonly DeepReadonly<TValue>[]
    : T extends object
      ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
      : T;

export type RollbackOutcome<Reason extends string> =
  | {
      ok: true;
      restoredPaths: string[];
      failedPaths: string[];
    }
  | {
      ok: false;
      restoredPaths: string[];
      failedPaths: string[];
      reason: Reason;
    };

export type SecurityEnforcementMode = "off" | "warn" | "enforce";

export type SecurityEnforcementPreference = SecurityEnforcementMode | "inherit";
