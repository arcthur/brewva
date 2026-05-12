import { describe, expect, test } from "bun:test";
import { expectGatewayFiles, readRepoFile } from "../gateway/shared.js";

const requiredAnchors = [
  "packages/brewva-gateway/src/channels/host.ts",
  "packages/brewva-gateway/src/channels/launcher.ts",
  "packages/brewva-gateway/src/channels/session/coordinator.ts",
  "packages/brewva-gateway/src/channels/command/router.ts",
  "packages/brewva-gateway/src/channels/channel-turn-dispatcher.ts",
  "packages/brewva-gateway/src/channels/channel-agent-dispatch.ts",
  "packages/brewva-gateway/src/channels/channel-reply-writer.ts",
] as const;

const disallowedAnchors = [
  "packages/brewva-gateway/src/channels/channel-session-coordinator.ts",
  "packages/brewva-gateway/src/channels/channel-control-router.ts",
] as const;

describe("channel gateway turn flow anchors", () => {
  test("locks the stable doc to current channel host and routing paths", () => {
    const markdown = readRepoFile("docs/journeys/operator/channel-gateway-and-turn-flow.md");

    expect(expectGatewayFiles(requiredAnchors)).toEqual([]);

    for (const anchor of requiredAnchors) {
      expect(markdown).toContain(anchor);
    }

    for (const anchor of disallowedAnchors) {
      expect(markdown).not.toContain(anchor);
    }
  });
});
