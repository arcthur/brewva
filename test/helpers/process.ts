export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    timer.unref?.();
  });
}

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  message = "timed out waiting for condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(25);
  }
  throw new Error(message);
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error(message)), timeoutMs);
      timer.unref?.();
    }),
  ]);
}
