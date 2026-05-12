import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { expectGatewayFiles, gatewayPath, gatewayRelative, readRepoFile } from "./shared.js";

describe("channels policy slicing", () => {
  test("keeps policy seams under channels/policy as the only implementation path", () => {
    expect(
      expectGatewayFiles([
        gatewayRelative("channels", "policy", "acl.ts"),
        gatewayRelative("channels", "policy", "channel-policy.ts"),
        gatewayRelative("channels", "policy", "eviction.ts"),
        gatewayRelative("channels", "policy", "routing-scope.ts"),
      ]),
    ).toEqual([]);

    expect(existsSync(gatewayPath("channels", "acl.ts"))).toBeFalse();
    expect(existsSync(gatewayPath("channels", "channel-policy.ts"))).toBeFalse();
    expect(existsSync(gatewayPath("channels", "eviction.ts"))).toBeFalse();
    expect(existsSync(gatewayPath("channels", "routing-scope.ts"))).toBeFalse();
  });

  test("wires runtime consumers directly to policy modules", () => {
    const router = readRepoFile("packages/brewva-gateway/src/channels/command/router.ts");
    const wiring = readRepoFile("packages/brewva-gateway/src/channels/wiring.ts");
    const dispatch = readRepoFile("packages/brewva-gateway/src/channels/channel-agent-dispatch.ts");
    const sessionCoordinator = readRepoFile(
      "packages/brewva-gateway/src/channels/session/coordinator.ts",
    );
    const admin = readRepoFile("packages/brewva-gateway/src/channels/command/admin.ts");

    expect(router).toContain('from "../policy/acl.js"');
    expect(wiring).toContain('from "./policy/channel-policy.js"');
    expect(dispatch).toContain('from "./policy/channel-policy.js"');
    expect(sessionCoordinator).toContain('from "../policy/eviction.js"');
    expect(sessionCoordinator).toContain('from "../policy/routing-scope.js"');
    expect(admin).toContain('from "../policy/acl.js"');
  });
});
