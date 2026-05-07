import {
  BrewvaDeferred,
  BrewvaEffect,
  BrewvaExit,
  BrewvaQueue,
  BrewvaScope,
  runPromiseAtBoundary,
  runSyncAtBoundary,
  type BrewvaBoundaryError,
} from "@brewva/brewva-effect";

export class ChannelSerialQueueClosedError extends Error {
  constructor(name: string) {
    super(`channel_serial_queue_closed:${name}`);
    this.name = "ChannelSerialQueueClosedError";
  }
}

type ChannelSerialQueueError = Error | BrewvaBoundaryError;

interface ChannelSerialQueueRequest<T> {
  readonly run: () => Promise<T>;
  readonly deferred: BrewvaDeferred.Deferred<T, ChannelSerialQueueError>;
}

function toChannelSerialQueueError(error: unknown): ChannelSerialQueueError {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

export interface ChannelEffectSerialQueueOptions {
  readonly name: string;
}

export interface ChannelEffectSerialQueue {
  readonly name: string;
  enqueue<T>(run: () => Promise<T>): Promise<T>;
  whenIdle(): Promise<void>;
  isIdle(): boolean;
  close(): Promise<void>;
}

export function createChannelEffectSerialQueue(
  options: ChannelEffectSerialQueueOptions,
): ChannelEffectSerialQueue {
  const scope = runSyncAtBoundary(BrewvaScope.make());
  const queue = runSyncAtBoundary(BrewvaQueue.unbounded<ChannelSerialQueueRequest<unknown>>());
  const pending = new Set<BrewvaDeferred.Deferred<unknown, ChannelSerialQueueError>>();
  const pendingPromises = new Set<Promise<unknown>>();
  const closeError = () => new ChannelSerialQueueClosedError(options.name);
  let closed = false;

  const runRequest = (request: ChannelSerialQueueRequest<unknown>) =>
    BrewvaEffect.gen(function* () {
      const exit = yield* BrewvaEffect.tryPromise({
        try: request.run,
        catch: toChannelSerialQueueError,
      }).pipe(BrewvaEffect.exit);
      yield* BrewvaDeferred.done(request.deferred, exit);
    });

  const failPending = (error: ChannelSerialQueueError): void => {
    for (const deferred of pending) {
      BrewvaDeferred.doneUnsafe(deferred, BrewvaEffect.fail(error));
    }
  };

  const drain = BrewvaQueue.take(queue).pipe(
    BrewvaEffect.flatMap((request) => runRequest(request)),
    BrewvaEffect.forever,
    BrewvaEffect.catch(() => BrewvaEffect.void),
  );

  runSyncAtBoundary(
    BrewvaScope.addFinalizer(
      scope,
      BrewvaEffect.sync(() => {
        failPending(closeError());
      }),
    ),
  );

  const drainLaunch = runPromiseAtBoundary(
    BrewvaScope.provide(scope)(
      drain.pipe(
        BrewvaEffect.forkScoped({
          startImmediately: true,
        }),
      ),
    ),
  ).catch(() => undefined);

  const offerRequest = async (request: ChannelSerialQueueRequest<unknown>): Promise<boolean> => {
    return await runPromiseAtBoundary(BrewvaQueue.offer(queue, request));
  };

  return {
    name: options.name,

    async enqueue<T>(run: () => Promise<T>): Promise<T> {
      if (closed) {
        throw closeError();
      }

      const deferred = runSyncAtBoundary(BrewvaDeferred.make<unknown, ChannelSerialQueueError>());
      pending.add(deferred);

      const request: ChannelSerialQueueRequest<unknown> = {
        run: async () => await run(),
        deferred,
      };
      const offered = await offerRequest(request);
      if (!offered) {
        pending.delete(deferred);
        throw closeError();
      }

      const result = runPromiseAtBoundary(BrewvaDeferred.await(deferred)).finally(() => {
        pending.delete(deferred);
        pendingPromises.delete(result);
      });
      pendingPromises.add(result);
      return (await result) as T;
    },

    async whenIdle(): Promise<void> {
      while (pendingPromises.size > 0) {
        await Promise.allSettled(pendingPromises);
      }
    },

    isIdle(): boolean {
      return pendingPromises.size === 0;
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await runPromiseAtBoundary(BrewvaQueue.interrupt(queue));
      await this.whenIdle();
      failPending(closeError());
      await drainLaunch;
      await runPromiseAtBoundary(BrewvaScope.close(scope, BrewvaExit.succeed(undefined)));
    },
  };
}
