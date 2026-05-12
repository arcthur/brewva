import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { expectGatewayFiles, gatewayPath, gatewayRelative, readRepoFile } from "./shared.js";

describe("channels a2a bridges slicing", () => {
  test("keeps a2a bridge ownership under channels/bridges/a2a", () => {
    expect(
      expectGatewayFiles([
        gatewayRelative("channels", "bridges", "a2a", "adapter.ts"),
        gatewayRelative("channels", "bridges", "a2a", "extension.ts"),
      ]),
    ).toEqual([]);

    expect(existsSync(gatewayPath("channels", "channel-a2a-adapter.ts"))).toBeFalse();
    expect(existsSync(gatewayPath("channels", "channel-a2a-extension.ts"))).toBeFalse();
  });

  test("wires host through the a2a bridge modules instead of flat channel files", () => {
    const wiring = readRepoFile("packages/brewva-gateway/src/channels/wiring.ts");

    expect(wiring).toContain('from "./bridges/a2a/adapter.js"');
    expect(wiring).toContain('from "./bridges/a2a/extension.js"');
    expect(wiring).not.toContain('from "./channel-a2a-adapter.js"');
    expect(wiring).not.toContain('from "./channel-a2a-extension.js"');
  });
});
