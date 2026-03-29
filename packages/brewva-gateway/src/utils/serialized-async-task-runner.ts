export function createSerializedAsyncTaskRunner(task: () => Promise<void>): {
  run: () => Promise<boolean>;
  whenIdle: () => Promise<void>;
} {
  let inFlight: Promise<void> | null = null;

  return {
    async run(): Promise<boolean> {
      if (inFlight) {
        return false;
      }
      inFlight = (async () => {
        try {
          await task();
        } finally {
          inFlight = null;
        }
      })();
      await inFlight;
      return true;
    },
    async whenIdle(): Promise<void> {
      await inFlight;
    },
  };
}
