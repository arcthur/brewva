import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { expectGatewayFiles, gatewayPath, gatewayRelative, readRepoFile } from "./shared.js";

describe("channels bridges slicing", () => {
  test("keeps telegram bridge ownership under channels/bridges and channel api exports", () => {
    expect(
      expectGatewayFiles([
        gatewayRelative("channels", "launcher.ts"),
        gatewayRelative("channels", "default-launchers.ts"),
        gatewayRelative("channels", "bridges", "telegram", "bridge.ts"),
        gatewayRelative("channels", "bridges", "telegram", "turn-bridge.ts"),
        gatewayRelative("channels", "bridges", "telegram", "launcher.ts"),
        gatewayRelative("channels", "bridges", "telegram", "webhook-config.ts"),
      ]),
    ).toEqual([]);

    const defaultLaunchers = readRepoFile(
      "packages/brewva-gateway/src/channels/default-launchers.ts",
    );
    const wiring = readRepoFile("packages/brewva-gateway/src/channels/wiring.ts");
    const channelsApi = readRepoFile("packages/brewva-gateway/src/channels/api.ts");

    expect(existsSync(gatewayPath("channels", "channel-bootstrap.ts"))).toBeFalse();
    expect(defaultLaunchers).toContain('from "./bridges/telegram/launcher.js"');
    expect(wiring).toContain('from "./launcher.js"');
    expect(wiring).toContain('from "./default-launchers.js"');
    expect(channelsApi).toContain('from "./bridges/telegram/bridge.js"');
    expect(channelsApi).toContain('from "./bridges/telegram/turn-bridge.js"');
  });
});
