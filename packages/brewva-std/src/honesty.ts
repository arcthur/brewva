// Honesty-class markers for provider-seam state.
//
// A value's "honesty class" is whether it is a durable replay fact, lossy
// telemetry, or an advisory hint. brewva already lives all three, but the
// distinction is spelled out only in prose. These phantom brands move it into the
// type system, so the compiler — not a convention — keeps lossy and advisory
// values out of durable sinks. The brands are erased at runtime: every `asX`
// helper is an identity cast and the symbol-keyed property never exists on the
// value. Each class uses its own `unique symbol`, so the three are mutually
// unassignable: a `Lossy<T>` can never satisfy a parameter that wants `Durable<T>`.
//
// The guarantee is ROUTING, not proof. A sink that wants `Durable<T>` cannot be handed a
// bare or `Lossy<T>` value by accident — that is the protection. But `asDurable(x)` only
// asserts "this is destined for a durable sink"; it does not prove `x` was persisted, and
// an explicit re-cast can still reclassify a value. Enforcement therefore lives at the
// sinks (the evidence sink demands `Lossy<object>`; the rotation recorder demands
// `Durable<…>`), not at the cast site.

declare const durableBrand: unique symbol;
declare const lossyBrand: unique symbol;
declare const advisoryBrand: unique symbol;

/**
 * A durable replay fact: it survives restart and is authoritative for
 * reconstruction (e.g. a tape lifecycle event such as a credential rotation).
 */
export type Durable<T> = T & { readonly [durableBrand]: true };

/**
 * Telemetry that may vanish on restart and is never replay authority (e.g. an
 * evidence-sink observation such as a provider cache-break sample).
 */
export type Lossy<T> = T & { readonly [lossyBrand]: true };

/**
 * A non-authoritative hint that never replaces terminal validation (e.g. a
 * streaming tool-call parse status).
 */
export type Advisory<T> = T & { readonly [advisoryBrand]: true };

/** Declare a value a durable replay fact. Identity at runtime. */
export function asDurable<T>(value: T): Durable<T> {
  return value as Durable<T>;
}

/** Declare a value lossy telemetry. Identity at runtime. */
export function asLossy<T>(value: T): Lossy<T> {
  return value as Lossy<T>;
}

/** Declare a value an advisory hint. Identity at runtime. */
export function asAdvisory<T>(value: T): Advisory<T> {
  return value as Advisory<T>;
}
