import { describe, expect, test } from "bun:test";
import { createReadUnchangedState } from "../../../packages/brewva-gateway/src/hosted/internal/provider/cache/index.js";

describe("read unchanged state", () => {
  test("returns unchanged only when the previous content is still visible and the file signature matches", () => {
    const state = createReadUnchangedState();
    const key = {
      path: "/workspace/src/app.ts",
      offset: 0,
      limit: 200,
      encoding: "utf8",
    };
    const signature = {
      size: 42,
      mtimeMs: 1000,
      contentHash: "hash-1",
    };

    expect(state.match({ sessionId: "session-1", key, signature, visibleHistoryEpoch: 1 })).toBe(
      undefined,
    );

    state.recordFullRead({
      sessionId: "session-1",
      key,
      signature,
      visibleHistoryEpoch: 1,
      readId: "read-1",
    });

    expect(state.match({ sessionId: "session-1", key, signature, visibleHistoryEpoch: 1 })).toEqual(
      {
        status: "unchanged",
        previousReadId: "read-1",
        visibleHistoryEpoch: 1,
      },
    );

    expect(
      state.match({
        sessionId: "session-1",
        key,
        signature,
        visibleHistoryEpoch: 2,
      }),
    ).toBe(undefined);

    state.recordFullRead({
      sessionId: "session-1",
      key,
      signature,
      visibleHistoryEpoch: 2,
      readId: "read-2",
    });

    expect(
      state.match({
        sessionId: "session-1",
        key,
        signature: { ...signature, mtimeMs: 2000, contentHash: "hash-2" },
        visibleHistoryEpoch: 2,
      }),
    ).toBe(undefined);

    state.clear("session-1");
    expect(state.match({ sessionId: "session-1", key, signature, visibleHistoryEpoch: 2 })).toBe(
      undefined,
    );
  });
});
