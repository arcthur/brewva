import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { expectGatewayFiles, readRepoFile } from "./shared.js";
import { gatewayPath } from "./shared.js";

describe("hosted settings boundary", () => {
  test("keeps hosted settings implementations under hosted/internal/session/settings", () => {
    expect(
      expectGatewayFiles([
        "packages/brewva-gateway/src/hosted/internal/session/settings/settings-store.ts",
        "packages/brewva-gateway/src/hosted/internal/session/settings/hosted-auth-store.ts",
        "packages/brewva-gateway/src/hosted/internal/session/settings/hosted-config-value.ts",
        "packages/brewva-gateway/src/hosted/internal/session/settings/hosted-model-registry.ts",
        "packages/brewva-gateway/src/hosted/internal/session/settings/model-presets.ts",
      ]),
    ).toEqual([]);

    expect(existsSync(gatewayPath("host", "settings-store.ts"))).toBeFalse();
    expect(existsSync(gatewayPath("host", "hosted-auth-store.ts"))).toBeFalse();
    expect(existsSync(gatewayPath("host", "hosted-config-value.ts"))).toBeFalse();
    expect(existsSync(gatewayPath("host", "hosted-model-registry.ts"))).toBeFalse();
    expect(existsSync(gatewayPath("host", "model-presets.ts"))).toBeFalse();
    expect(readRepoFile("packages/brewva-gateway/src/hosted/session.ts")).toContain(
      'from "./internal/session/settings/model-presets.js"',
    );
  });
});
