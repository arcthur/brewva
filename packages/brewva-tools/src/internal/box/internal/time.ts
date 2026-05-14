import { sleepAtBoundary } from "@brewva/brewva-effect";

export function nowIso(): string {
  return new Date().toISOString();
}

export function sleep(ms: number): Promise<void> {
  return sleepAtBoundary(ms);
}
