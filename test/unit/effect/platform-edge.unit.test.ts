import { describe, expect, test } from "bun:test";
import {
  Effect,
  runPlatformEdgeOperation,
  runPlatformEdgeOperationSync,
} from "@brewva/brewva-effect/edge";

describe("platform-neutral Effect edge runner", () => {
  test("runs platform-neutral public edges with scope and observability", async () => {
    const finalized: string[] = [];

    const result = await runPlatformEdgeOperation(
      "brewva.test.worker.edge",
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            finalized.push("closed");
          }),
        );
        const span = yield* Effect.currentSpan;
        return span.name;
      }),
      {
        fields: {
          edge: "worker",
        },
      },
    );

    expect(result).toBe("brewva.test.worker.edge");
    expect(finalized).toEqual(["closed"]);
  });

  test("runs synchronous platform-neutral public edges through the same envelope", () => {
    const result = runPlatformEdgeOperationSync(
      "brewva.test.worker.sync",
      Effect.currentSpan.pipe(Effect.map((span) => span.name)),
    );

    expect(result).toBe("brewva.test.worker.sync");
  });
});
