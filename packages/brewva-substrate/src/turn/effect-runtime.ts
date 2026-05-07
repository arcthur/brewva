import {
  BrewvaContext,
  BrewvaDeferred,
  BrewvaEffect,
  BrewvaInterruptedError,
  BrewvaLayer,
  BrewvaOption,
  BrewvaQueue,
  type BrewvaBoundaryError,
  type BrewvaRunOptions,
  type BrewvaScope,
  fromAbortableBoundaryPromise,
  runPromiseAtBoundary,
} from "@brewva/brewva-effect";
import type { BrewvaTurnEventScope, BrewvaTurnLoopEvent } from "./types.js";

export type BrewvaTurnLoopEventSink = (
  event: BrewvaTurnLoopEvent,
  scope: BrewvaTurnEventScope,
  signal: AbortSignal | undefined,
) => Promise<BrewvaTurnLoopEvent | void> | BrewvaTurnLoopEvent | void;

export type BrewvaTurnRuntimeError = BrewvaBoundaryError | BrewvaInterruptedError;

export interface BrewvaTurnEventCallbackOptions {
  readonly runOptions?: BrewvaRunOptions;
  readonly scope: BrewvaTurnEventScope;
}

export interface BrewvaTurnEventDispatcher {
  emit(
    event: BrewvaTurnLoopEvent,
  ): BrewvaEffect.Effect<BrewvaTurnLoopEvent, BrewvaTurnRuntimeError, BrewvaTurnScope>;
  captureScope(): BrewvaEffect.Effect<BrewvaTurnEventScope, never, BrewvaTurnScope>;
  emitFromCallback(
    event: BrewvaTurnLoopEvent,
    options: BrewvaTurnEventCallbackOptions,
  ): Promise<BrewvaTurnLoopEvent>;
}

export interface BrewvaTurnScopeShape {
  readonly sessionId?: string;
  readonly turnId?: string;
}

export class BrewvaTurnScope extends BrewvaContext.Service<BrewvaTurnScope, BrewvaTurnScopeShape>()(
  "@brewva/brewva-substrate/TurnScope",
) {
  static layer(input: BrewvaTurnScopeShape) {
    return BrewvaLayer.succeed(this, this.of(input));
  }
}

export interface BrewvaToolInvocationScopeShape {
  readonly toolCallId: string;
  readonly toolName: string;
}

export class BrewvaToolInvocationScope extends BrewvaContext.Service<
  BrewvaToolInvocationScope,
  BrewvaToolInvocationScopeShape
>()("@brewva/brewva-substrate/ToolInvocationScope") {
  static layer(input: BrewvaToolInvocationScopeShape) {
    return BrewvaLayer.succeed(this, this.of(input));
  }
}

interface TurnEventRequest {
  readonly event: BrewvaTurnLoopEvent;
  readonly scope: BrewvaTurnEventScope;
  readonly deferred: BrewvaDeferred.Deferred<BrewvaTurnLoopEvent, BrewvaTurnRuntimeError>;
}

function resolveReturnedEvent(
  event: BrewvaTurnLoopEvent,
  returned: BrewvaTurnLoopEvent | void,
): BrewvaTurnLoopEvent {
  return returned ?? event;
}

function runTurnEventSinkBoundary(
  sink: BrewvaTurnLoopEventSink,
  event: BrewvaTurnLoopEvent,
  scope: BrewvaTurnEventScope,
): BrewvaEffect.Effect<BrewvaTurnLoopEvent, BrewvaTurnRuntimeError> {
  return fromAbortableBoundaryPromise((signal) => Promise.resolve(sink(event, scope, signal))).pipe(
    BrewvaEffect.map((returned) => resolveReturnedEvent(event, returned)),
  );
}

function copyTurnScope(scope: BrewvaTurnScopeShape): BrewvaTurnScopeShape {
  return {
    sessionId: scope.sessionId,
    turnId: scope.turnId,
  };
}

function copyToolInvocationScope(
  scope: BrewvaToolInvocationScopeShape,
): BrewvaToolInvocationScopeShape {
  return {
    toolCallId: scope.toolCallId,
    toolName: scope.toolName,
  };
}

function captureScope(): BrewvaEffect.Effect<BrewvaTurnEventScope, never, BrewvaTurnScope> {
  return BrewvaEffect.gen(function* () {
    const turn = yield* BrewvaTurnScope;
    const toolInvocation = BrewvaOption.getOrUndefined(
      yield* BrewvaEffect.serviceOption(BrewvaToolInvocationScope),
    );

    return {
      turn: copyTurnScope(turn),
      ...(toolInvocation ? { toolInvocation: copyToolInvocationScope(toolInvocation) } : {}),
    };
  });
}

function provideCapturedScope<A, E, R>(
  scope: BrewvaTurnEventScope,
  effect: BrewvaEffect.Effect<A, E, R>,
): BrewvaEffect.Effect<A, E, R> {
  const withTurn = effect.pipe(
    BrewvaEffect.provide(BrewvaTurnScope.layer(copyTurnScope(scope.turn))),
  );
  if (!scope.toolInvocation) {
    return withTurn;
  }
  return withTurn.pipe(
    BrewvaEffect.provide(
      BrewvaToolInvocationScope.layer(copyToolInvocationScope(scope.toolInvocation)),
    ),
  );
}

export function createTurnEventDispatcher(
  sink: BrewvaTurnLoopEventSink,
): BrewvaEffect.Effect<BrewvaTurnEventDispatcher, never, BrewvaScope.Scope> {
  return BrewvaEffect.gen(function* () {
    const queue = yield* BrewvaQueue.unbounded<TurnEventRequest>();
    const pending = new Set<BrewvaDeferred.Deferred<BrewvaTurnLoopEvent, BrewvaTurnRuntimeError>>();

    yield* BrewvaEffect.addFinalizer(() =>
      BrewvaEffect.gen(function* () {
        const closed = new BrewvaInterruptedError({
          message: "Turn event dispatcher scope closed",
        });
        for (const deferred of pending) {
          yield* BrewvaDeferred.fail(deferred, closed);
        }
        pending.clear();
        yield* BrewvaQueue.shutdown(queue);
      }).pipe(BrewvaEffect.asVoid),
    );

    const consumeOne = BrewvaEffect.gen(function* () {
      const request = yield* BrewvaQueue.take(queue);
      const exit = yield* provideCapturedScope(
        request.scope,
        runTurnEventSinkBoundary(sink, request.event, request.scope),
      ).pipe(BrewvaEffect.exit);
      yield* BrewvaDeferred.done(request.deferred, exit);
    });

    yield* consumeOne.pipe(BrewvaEffect.forever, BrewvaEffect.forkScoped);

    const emitWithScope = (
      event: BrewvaTurnLoopEvent,
      scope: BrewvaTurnEventScope,
    ): BrewvaEffect.Effect<BrewvaTurnLoopEvent, BrewvaTurnRuntimeError> =>
      BrewvaEffect.gen(function* () {
        const deferred = yield* BrewvaDeferred.make<BrewvaTurnLoopEvent, BrewvaTurnRuntimeError>();
        yield* BrewvaEffect.sync(() => {
          pending.add(deferred);
        });
        const offered = yield* BrewvaQueue.offer(queue, { event, scope, deferred });
        if (!offered) {
          yield* BrewvaEffect.sync(() => {
            pending.delete(deferred);
          });
          return yield* BrewvaEffect.fail(
            new BrewvaInterruptedError({
              message: "Turn event dispatcher scope closed",
            }),
          );
        }
        return yield* BrewvaDeferred.await(deferred).pipe(
          BrewvaEffect.ensuring(
            BrewvaEffect.sync(() => {
              pending.delete(deferred);
            }),
          ),
        );
      });

    const emitEffect = (
      event: BrewvaTurnLoopEvent,
    ): BrewvaEffect.Effect<BrewvaTurnLoopEvent, BrewvaTurnRuntimeError, BrewvaTurnScope> =>
      BrewvaEffect.gen(function* () {
        const scope = yield* captureScope();
        return yield* emitWithScope(event, scope);
      });

    return {
      emit: emitEffect,
      captureScope,
      emitFromCallback(event, options) {
        const effect = emitWithScope(event, options.scope);
        return runPromiseAtBoundary(effect, options?.runOptions);
      },
    };
  });
}
