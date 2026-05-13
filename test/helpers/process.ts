export function createUnrefTimer(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, ms);
  timer.unref?.();
  return timer;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolveSleep) => {
    createUnrefTimer(resolveSleep, ms);
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, rejectPromise) => {
        timer = createUnrefTimer(() => rejectPromise(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
