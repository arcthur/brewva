import { type BrewvaBoundaryError } from "@brewva/brewva-effect";
import {
  BrewvaContext,
  BrewvaDeferred,
  BrewvaEffect,
  BrewvaLayer,
  BrewvaQueue,
} from "@brewva/brewva-effect/primitives";
import { createBrewvaServiceRuntime } from "@brewva/brewva-effect/runtime";

export class ChannelSerialQueueClosedError extends Error {
  constructor(name: string) {
    super(`channel_serial_queue_closed:${name}`);
    this.name = "ChannelSerialQueueClosedError";
  }
}

type ChannelSerialQueueError = Error | BrewvaBoundaryError;

interface ChannelSerialQueueRequest {
  readonly run: () => BrewvaEffect.Effect<void>;
}

export interface ChannelSerialQueueOptions {
  readonly name: string;
}

export interface ChannelSerialQueueServiceShape {
  readonly name: string;
  enqueue<T>(
    run: () => BrewvaEffect.Effect<T, unknown>,
  ): BrewvaEffect.Effect<T, ChannelSerialQueueError>;
  whenIdle(): BrewvaEffect.Effect<void>;
  isIdle(): BrewvaEffect.Effect<boolean>;
  close(): BrewvaEffect.Effect<void>;
}

export interface ChannelSerialQueueRuntime {
  readonly name: string;
  enqueue<T>(run: () => Promise<T>): Promise<T>;
  whenIdle(): Promise<void>;
  isIdle(): Promise<boolean>;
  closeIfIdle(): Promise<boolean>;
  close(): Promise<void>;
}

function toChannelSerialQueueError(error: unknown): ChannelSerialQueueError {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

const makeChannelSerialQueue = BrewvaEffect.fn("gateway.channel.serialQueue.make")(function* (
  options: ChannelSerialQueueOptions,
) {
  const queue = yield* BrewvaQueue.unbounded<ChannelSerialQueueRequest>();
  const pending = new Set<(error: ChannelSerialQueueError) => void>();
  let idleSignal = yield* BrewvaDeferred.make<void>();
  let closed = false;

  const closeError = () => new ChannelSerialQueueClosedError(options.name);
  const ensureOpen = () => (closed ? BrewvaEffect.fail(closeError()) : BrewvaEffect.void);
  const signalIdleIfNeeded = (): void => {
    if (pending.size === 0) {
      BrewvaDeferred.doneUnsafe(idleSignal, BrewvaEffect.void);
    }
  };
  const failPending = (error: ChannelSerialQueueError): void => {
    for (const fail of pending) {
      fail(error);
    }
    pending.clear();
    signalIdleIfNeeded();
  };

  const runRequest = (request: ChannelSerialQueueRequest) => request.run();

  const drain = BrewvaQueue.take(queue).pipe(
    BrewvaEffect.flatMap((request) => runRequest(request)),
    BrewvaEffect.forever,
    BrewvaEffect.catch(() => BrewvaEffect.void),
  );

  yield* drain.pipe(
    BrewvaEffect.forkScoped({
      startImmediately: true,
    }),
  );
  yield* BrewvaEffect.addFinalizer(() =>
    BrewvaEffect.sync(() => {
      closed = true;
      failPending(closeError());
    }),
  );

  return {
    name: options.name,
    enqueue<T>(
      run: () => BrewvaEffect.Effect<T, unknown>,
    ): BrewvaEffect.Effect<T, ChannelSerialQueueError> {
      return BrewvaEffect.gen(function* () {
        yield* ensureOpen();
        if (pending.size === 0) {
          idleSignal = yield* BrewvaDeferred.make<void>();
        }
        const deferred = yield* BrewvaDeferred.make<T, ChannelSerialQueueError>();
        const fail = (error: ChannelSerialQueueError): void => {
          BrewvaDeferred.doneUnsafe(deferred, BrewvaEffect.fail(error));
        };
        pending.add(fail);
        const offered = yield* BrewvaQueue.offer(queue, {
          run: () =>
            run().pipe(
              BrewvaEffect.catch((error) => BrewvaEffect.fail(toChannelSerialQueueError(error))),
              BrewvaEffect.exit,
              BrewvaEffect.flatMap((exit) => BrewvaDeferred.done(deferred, exit)),
              BrewvaEffect.ensuring(
                BrewvaEffect.sync(() => {
                  pending.delete(fail);
                  signalIdleIfNeeded();
                }),
              ),
            ),
        });
        if (!offered) {
          pending.delete(fail);
          signalIdleIfNeeded();
          return yield* BrewvaEffect.fail(closeError());
        }
        return yield* BrewvaDeferred.await(deferred);
      });
    },
    whenIdle(): BrewvaEffect.Effect<void> {
      return BrewvaEffect.gen(function* () {
        while (pending.size > 0) {
          yield* BrewvaDeferred.await(idleSignal);
        }
      });
    },
    isIdle(): BrewvaEffect.Effect<boolean> {
      return BrewvaEffect.sync(() => pending.size === 0);
    },
    close(): BrewvaEffect.Effect<void> {
      return BrewvaEffect.gen(function* () {
        if (closed) {
          return;
        }
        closed = true;
        yield* BrewvaQueue.interrupt(queue);
        failPending(closeError());
        yield* BrewvaDeferred.await(idleSignal);
      });
    },
  } satisfies ChannelSerialQueueServiceShape;
});

export class ChannelSerialQueueService extends BrewvaContext.Service<
  ChannelSerialQueueService,
  ChannelSerialQueueServiceShape
>()("@brewva/Gateway/ChannelSerialQueue") {
  static layer(options: ChannelSerialQueueOptions) {
    return BrewvaLayer.effect(this, makeChannelSerialQueue(options));
  }
}

export function createChannelSerialQueueRuntime(
  options: ChannelSerialQueueOptions,
): ChannelSerialQueueRuntime {
  const runtime = createBrewvaServiceRuntime(
    ChannelSerialQueueService,
    ChannelSerialQueueService.layer(options),
    {
      name: `gateway.channel.serialQueue.${options.name}`,
    },
  );
  let closed = false;
  let activeSubmissions = 0;
  const submissionIdleWaiters = new Set<() => void>();

  const withService = async <T>(
    operation: (queue: ChannelSerialQueueServiceShape) => BrewvaEffect.Effect<T, unknown>,
  ): Promise<T> => {
    return await runtime.runService(operation);
  };
  const signalSubmissionsIdleIfNeeded = (): void => {
    if (activeSubmissions !== 0) {
      return;
    }
    for (const resolve of submissionIdleWaiters) {
      resolve();
    }
    submissionIdleWaiters.clear();
  };
  const reserveSubmission = (): (() => void) => {
    activeSubmissions += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      activeSubmissions -= 1;
      signalSubmissionsIdleIfNeeded();
    };
  };
  const waitForSubmissionIdle = async (): Promise<void> => {
    if (activeSubmissions === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      submissionIdleWaiters.add(resolve);
    });
    await waitForSubmissionIdle();
  };

  return {
    name: options.name,
    enqueue<T>(run: () => Promise<T>): Promise<T> {
      if (closed) {
        return Promise.reject(new ChannelSerialQueueClosedError(options.name));
      }
      const releaseSubmission = reserveSubmission();
      const result = withService((queue) =>
        queue.enqueue(() =>
          BrewvaEffect.tryPromise({
            try: run,
            catch: toChannelSerialQueueError,
          }),
        ),
      );
      return result.finally(releaseSubmission);
    },
    async whenIdle(): Promise<void> {
      if (closed) {
        return;
      }
      while (true) {
        await waitForSubmissionIdle();
        if (closed) {
          return;
        }
        await runtime.runService((queue) => queue.whenIdle());
        if (activeSubmissions === 0) {
          return;
        }
      }
    },
    async isIdle(): Promise<boolean> {
      if (closed) {
        return true;
      }
      if (activeSubmissions > 0) {
        return false;
      }
      return await runtime.runService((queue) => queue.isIdle());
    },
    async closeIfIdle(): Promise<boolean> {
      if (closed) {
        return true;
      }
      if (activeSubmissions > 0) {
        return false;
      }
      const serviceIdle = await runtime.runService((queue) => queue.isIdle());
      if (!serviceIdle || activeSubmissions > 0 || closed) {
        return false;
      }
      closed = true;
      await runtime.runService((queue) => queue.close());
      await waitForSubmissionIdle();
      await runtime.dispose();
      return true;
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await runtime.runService((queue) => queue.close());
      await waitForSubmissionIdle();
      await runtime.dispose();
    },
  };
}
