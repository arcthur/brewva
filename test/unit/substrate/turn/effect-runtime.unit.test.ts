import { describe, expect, test } from "bun:test";
import { BrewvaEffect, runPromiseAtBoundary } from "@brewva/brewva-effect";
import {
  BrewvaToolInvocationScope,
  BrewvaTurnScope,
  createTurnEventDispatcher,
  type BrewvaTurnLoopEvent,
} from "@brewva/brewva-substrate/turn";
import { sleep } from "../../../helpers/process.js";

function userMessage() {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text: "hello" }],
    timestamp: Date.now(),
  };
}

describe("turn Effect runtime", () => {
  test("dispatches turn events through a scoped serial Effect dispatcher", async () => {
    const observed: string[] = [];

    await runPromiseAtBoundary(
      BrewvaEffect.scoped(
        BrewvaEffect.gen(function* () {
          const dispatcher = yield* createTurnEventDispatcher(async (event) => {
            if (event.type === "message_end") {
              await sleep(10);
            }
            observed.push(event.type);
            return event;
          });

          yield* dispatcher.emit({ type: "agent_start" });
          yield* dispatcher.emit({ type: "message_start", message: userMessage() });
          const returned = yield* dispatcher.emit({ type: "message_end", message: userMessage() });
          expect(returned.type).toBe("message_end");
        }),
      ).pipe(BrewvaEffect.provide(BrewvaTurnScope.layer({ sessionId: "session-dispatcher" }))),
    );

    expect(observed).toEqual(["agent_start", "message_start", "message_end"]);
  });

  test("exposes named turn and tool invocation scopes as Effect services", async () => {
    const result = await runPromiseAtBoundary(
      BrewvaEffect.gen(function* () {
        const turn = yield* BrewvaTurnScope;
        const tool = yield* BrewvaToolInvocationScope;
        return {
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
        };
      }).pipe(
        BrewvaEffect.provide(
          BrewvaToolInvocationScope.layer({ toolCallId: "call-1", toolName: "read" }),
        ),
        BrewvaEffect.provide(BrewvaTurnScope.layer({ sessionId: "session-1", turnId: "turn-1" })),
      ),
    );

    expect(result).toEqual({
      sessionId: "session-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      toolName: "read",
    });
  });

  test("propagates listener failures to the emitting fiber without skipping later events", async () => {
    const observed: BrewvaTurnLoopEvent["type"][] = [];

    await runPromiseAtBoundary(
      BrewvaEffect.scoped(
        BrewvaEffect.gen(function* () {
          const dispatcher = yield* createTurnEventDispatcher((event) => {
            observed.push(event.type);
            if (event.type === "turn_start") {
              throw new Error("listener failed");
            }
          });

          const error = yield* dispatcher.emit({ type: "turn_start" }).pipe(BrewvaEffect.flip);
          expect(error).toBeInstanceOf(Error);

          yield* dispatcher.emit({ type: "agent_start" });
        }),
      ).pipe(BrewvaEffect.provide(BrewvaTurnScope.layer({ sessionId: "session-failure" }))),
    );

    expect(observed).toEqual(["turn_start", "agent_start"]);
  });

  test("passes an abort signal through the turn event sink boundary", async () => {
    const observed: boolean[] = [];

    await runPromiseAtBoundary(
      BrewvaEffect.scoped(
        BrewvaEffect.gen(function* () {
          const dispatcher = yield* createTurnEventDispatcher((_event, _scope, signal) => {
            observed.push(signal instanceof AbortSignal);
          });

          yield* dispatcher.emit({ type: "agent_start" });
        }),
      ).pipe(BrewvaEffect.provide(BrewvaTurnScope.layer({ sessionId: "session-signal" }))),
    );

    expect(observed).toEqual([true]);
  });

  test("fails callback emissions after the owning scope closes", async () => {
    const dispatcher = await runPromiseAtBoundary(
      BrewvaEffect.scoped(
        BrewvaEffect.gen(function* () {
          const created = yield* createTurnEventDispatcher(() => undefined);
          return created;
        }),
      ).pipe(BrewvaEffect.provide(BrewvaTurnScope.layer({ sessionId: "session-closed" }))),
    );

    let error: unknown;
    try {
      await dispatcher.emitFromCallback(
        { type: "agent_start" },
        {
          scope: {
            turn: {
              sessionId: "session-closed",
            },
          },
        },
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Turn event dispatcher scope closed");
  });
});
