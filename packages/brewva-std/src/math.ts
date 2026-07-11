/**
 * Clamp `value` into the inclusive range `[min, max]`. Assumes `min <= max`;
 * a reversed range is caller error and yields `min` (the outer `Math.max`
 * wins), matching the dominant hand-written `Math.max(min, Math.min(max, v))`
 * form this centralizes. `NaN` propagates — `Math.min`/`Math.max` return `NaN`
 * for a `NaN` operand — again matching the inline form, so callers that need a
 * `NaN` policy (e.g. coerce to a default) must guard before calling.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Clamp `value` into the unit interval `[0, 1]`. `NaN` propagates (see {@link clamp}). */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/**
 * Truncate `value` toward zero to an integer, then clamp into `[min, max]`.
 * Matches the byte-identical `Math.max(min, Math.min(max, Math.trunc(v)))`
 * helpers this centralizes. Truncation happens before clamping, so a fractional
 * value never escapes the integer bounds. Callers that must reject non-finite
 * input should guard before calling (this returns `NaN` for a `NaN` input).
 */
export function clampInt(value: number, min: number, max: number): number {
  return clamp(Math.trunc(value), min, max);
}
