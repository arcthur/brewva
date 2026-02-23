import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  resolveBackendWorkingCwd,
  resolveGatewayFailureStage,
  shouldFallbackAfterGatewayFailure,
} from "@brewva/brewva-cli";

describe("gateway fallback boundary", () => {
  test("auto backend allows fallback on pre-ack failures", () => {
    expect(shouldFallbackAfterGatewayFailure("auto", "pre-ack")).toBe(true);
  });

  test("auto backend blocks fallback on post-ack failures", () => {
    expect(shouldFallbackAfterGatewayFailure("auto", "post-ack")).toBe(false);
  });

  test("classifies send-requested failures as post-ack safety boundary", () => {
    expect(
      resolveGatewayFailureStage({
        sendRequested: true,
        ackReceived: false,
      }),
    ).toBe("post-ack");
  });

  test("classifies pure pre-send failures as pre-ack", () => {
    expect(
      resolveGatewayFailureStage({
        sendRequested: false,
        ackReceived: false,
      }),
    ).toBe("pre-ack");
  });

  test("resolves backend cwd from explicit value", () => {
    expect(resolveBackendWorkingCwd("./test")).toBe(resolve("./test"));
  });

  test("resolves backend cwd from process cwd when unset", () => {
    expect(resolveBackendWorkingCwd()).toBe(process.cwd());
  });
});
