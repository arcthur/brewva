/**
 * Durability levels of the append-only recovery substrate (event tape and
 * Recovery WAL). Between flush boundaries the logs are `process_crash` durable
 * (the OS page cache survives a process or worker kill); at a flushed boundary
 * (a committed turn or checkpoint, a terminal WAL mark) they are `power_loss`
 * durable (fsync'd to disk).
 */
export const DURABILITY_LEVELS = ["process_crash", "power_loss"] as const;
export type DurabilityLevel = (typeof DURABILITY_LEVELS)[number];

/**
 * Effect-delivery guarantee of recovery: a restart re-drives the accepted
 * envelope, and external effects are deduped best-effort (dedupe key plus event
 * id), so delivery is at-least-once, not exactly-once.
 */
export const EFFECT_DELIVERY = "at_least_once" as const;
export type EffectDelivery = typeof EFFECT_DELIVERY;
