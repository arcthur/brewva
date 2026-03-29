export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

export async function waitForAllSettledWithTimeout(
  promises: Promise<unknown>[],
  timeoutMs: number,
): Promise<void> {
  if (promises.length === 0) {
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, timeoutMs));
  });

  await Promise.race([
    Promise.allSettled(promises).then(() => {
      clearTimeout(timer);
    }),
    timeoutPromise,
  ]);
}
