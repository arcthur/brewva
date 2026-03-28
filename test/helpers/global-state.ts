import { afterEach, beforeEach } from "bun:test";

export const TEST_INTRINSIC_DATE_NOW = Date.now;

let guardsInstalled = false;
let envSnapshot: Record<string, string | undefined> = snapshotProcessEnv();

function snapshotProcessEnv(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).map(([key, value]) => [key, value]),
  ) as Record<string, string | undefined>;
}

export function restoreProcessEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (typeof value === "string") {
      process.env[key] = value;
      continue;
    }
    delete process.env[key];
  }
}

export function patchProcessEnv(overrides: Record<string, string | undefined>): () => void {
  const snapshot = snapshotProcessEnv();
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "string") {
      process.env[key] = value;
      continue;
    }
    delete process.env[key];
  }
  return () => {
    restoreProcessEnv(snapshot);
  };
}

export function patchDateNow(now: () => number): () => void {
  const previous = Date.now;
  Date.now = now;
  return () => {
    Date.now = previous;
  };
}

export function installTestIsolationGuards(): void {
  if (guardsInstalled) {
    return;
  }
  guardsInstalled = true;

  beforeEach(() => {
    envSnapshot = snapshotProcessEnv();
    Date.now = TEST_INTRINSIC_DATE_NOW;
  });

  afterEach(() => {
    restoreProcessEnv(envSnapshot);
    Date.now = TEST_INTRINSIC_DATE_NOW;
  });
}
