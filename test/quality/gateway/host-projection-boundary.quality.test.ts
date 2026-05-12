import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { expectGatewayFiles, gatewayPath, readRepoFile } from "./shared.js";

describe("host projection boundary", () => {
  test("keeps projection helpers under host/projection without duplicate root twins", () => {
    expect(
      expectGatewayFiles([
        "packages/brewva-gateway/src/hosted/internal/session/projection/context-entry-linker.ts",
        "packages/brewva-gateway/src/hosted/internal/session/projection/workbench-visibility.ts",
        "packages/brewva-gateway/src/hosted/internal/session/projection/runtime-projection-session-store.ts",
      ]),
    ).toEqual([]);

    expect(existsSync(gatewayPath("host", "workbench-visibility.ts"))).toBeFalse();
    expect(existsSync(gatewayPath("host", "legacy-hosted-session-projection.ts"))).toBeFalse();
    expect(
      existsSync(gatewayPath("host", "projection", "legacy-hosted-session-projection.ts")),
    ).toBeFalse();
    expect(existsSync(gatewayPath("host", "runtime-projection-session-store.ts"))).toBeFalse();
    expect(
      readRepoFile(
        "packages/brewva-gateway/src/hosted/internal/session/projection/runtime-projection-session-store.ts",
      ),
    ).toContain('from "./workbench-visibility.js"');
    expect(
      readRepoFile(
        "packages/brewva-gateway/src/hosted/internal/session/projection/runtime-projection-session-store.ts",
      ),
    ).toContain('from "./context-entry-linker.js"');
  });
});
