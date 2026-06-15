import { describe, expect, test } from "bun:test";
import type { RuntimeToolAuthorityResolver } from "@brewva/brewva-runtime";

/**
 * WS1 made `sessionId` a REQUIRED parameter of the public
 * `RuntimeToolAuthorityResolver` signature (the kernel always supplies it from
 * `commitment.call.sessionId`). This is a deliberate breaking change — recorded
 * in the squash commit's BREAKING CHANGE footer and the RFC. This contract locks
 * it: a caller that omits `sessionId` must fail to type-check. If the parameter
 * is ever loosened back to optional, the `@ts-expect-error` below becomes unused
 * and the test typecheck (`bun run typecheck:test`) fails.
 */
describe("RuntimeToolAuthorityResolver signature contract", () => {
  test("requires sessionId — callers must pass tool name, args, and sessionId", () => {
    let observedSessionId: string | undefined;
    const resolver: RuntimeToolAuthorityResolver = (toolName, _args, sessionId) => {
      observedSessionId = sessionId;
      return {
        decision: "allow",
        reason: toolName,
      } as unknown as ReturnType<RuntimeToolAuthorityResolver>;
    };

    resolver("read_file", { path: "x" }, "session-1");
    expect(observedSessionId).toBe("session-1");

    // @ts-expect-error sessionId is required, not optional (WS1 breaking change).
    resolver("read_file", { path: "x" });
  });
});
