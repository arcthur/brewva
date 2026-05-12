import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { expectGatewayFiles, gatewayPath, gatewayRelative, readRepoFile } from "./shared.js";

const expectedKinds = [
  "agents",
  "status",
  "answer",
  "update",
  "steer",
  "focus",
  "agent-create",
  "agent-delete",
  "run",
  "discuss",
  "route-agent",
] as const;

describe("channels command union", () => {
  test("defines the control command discriminant set", () => {
    const source = readRepoFile("packages/brewva-gateway/src/channels/types.ts");
    for (const kind of expectedKinds) {
      expect(source).toContain(`kind: "${kind}"`);
    }
  });

  test("routes channel control handling through the typed control-command seam", () => {
    const api = readRepoFile("packages/brewva-gateway/src/channels/api.ts");
    const router = readRepoFile("packages/brewva-gateway/src/channels/command/router.ts");
    const host = readRepoFile("packages/brewva-gateway/src/channels/host.ts");
    const wiring = readRepoFile("packages/brewva-gateway/src/channels/wiring.ts");
    const ports = readRepoFile("packages/brewva-gateway/src/channels/ports.ts");
    const seam = readRepoFile("packages/brewva-gateway/src/channels/control-command.ts");
    const sessionCoordinator = readRepoFile(
      "packages/brewva-gateway/src/channels/session/coordinator.ts",
    );
    expect(
      expectGatewayFiles([
        gatewayRelative("channels", "command", "status.ts"),
        gatewayRelative("channels", "command", "answer.ts"),
        gatewayRelative("channels", "command", "steer.ts"),
        gatewayRelative("channels", "command", "update.ts"),
        gatewayRelative("channels", "command", "admin.ts"),
        gatewayRelative("channels", "command", "contracts.ts"),
        gatewayRelative("channels", "command", "dispatch.ts"),
        gatewayRelative("channels", "command", "parser.ts"),
        gatewayRelative("channels", "command", "router.ts"),
        gatewayRelative("channels", "wiring.ts"),
        gatewayRelative("channels", "ports.ts"),
        gatewayRelative("channels", "session", "coordinator.ts"),
        gatewayRelative("channels", "session", "binding-store.ts"),
        gatewayRelative("channels", "session", "queries.ts"),
        gatewayRelative("channels", "session", "update-lock.ts"),
      ]),
    ).toEqual([]);
    expect(router).toContain("resolveChannelControlCommand");
    expect(router).toContain("isPublicChannelControlCommand");
    expect(router).toContain("const handlers:");
    expect(router).toContain('from "../session/coordinator.js"');
    expect(router).toContain('from "../session/queries.js"');
    expect(router).toContain('from "../session/update-lock.js"');
    expect(host).toContain('from "./wiring.js"');
    expect(wiring).toContain('from "./session/coordinator.js"');
    expect(wiring).toContain('from "./session/queries.js"');
    expect(wiring).toContain('from "./session/update-lock.js"');
    expect(ports).toContain("interface ChannelSessionPromptPort");
    expect(ports).toContain("interface ChannelOperatorCommandPort");
    expect(ports).not.toContain("../host/api.js");
    expect(ports).not.toContain("./channel-agent-dispatch.js");
    expect(api).not.toContain("ConversationBindingStore");
    expect(api).toContain('from "./ports.js"');
    expect(api).toContain('from "./command/contracts.js"');
    expect(api).toContain('from "./command/parser.js"');
    expect(sessionCoordinator).toContain("const DEFAULT_CLEANUP_GRACEFUL_TIMEOUT_MS = 2_000;");
    expect(sessionCoordinator).not.toContain("../../host/api.js");
    expect(existsSync(gatewayPath("channels", "index.ts"))).toBeFalse();
    expect(existsSync(gatewayPath("channels", "channel-session-coordinator.ts"))).toBeFalse();
    expect(existsSync(gatewayPath("channels", "channel-control-router.ts"))).toBeFalse();
    expect(existsSync(gatewayPath("channels", "command-router.ts"))).toBeFalse();
    expect(existsSync(gatewayPath("channels", "channel-command-contracts.ts"))).toBeFalse();
    expect(existsSync(gatewayPath("channels", "channel-command-dispatch.ts"))).toBeFalse();
    expect(existsSync(gatewayPath("conversations", "binding-store.ts"))).toBeFalse();
    expect(router).toContain('from "./status.js"');
    expect(router).toContain('from "./answer.js"');
    expect(router).toContain('from "./update.js"');
    expect(router).toContain('from "./contracts.js"');
    expect(router).toContain('from "./dispatch.js"');
    expect(seam).toContain('case "status"');
    expect(seam).toContain('case "route-agent"');
  });
});
