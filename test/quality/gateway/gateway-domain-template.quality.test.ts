import { describe, expect, test } from "bun:test";
import { expectGatewayFiles, gatewayRelative } from "./shared.js";

const required = [
  gatewayRelative("admin", "api.ts"),
  gatewayRelative("admin", "types.ts"),
  gatewayRelative("admin", "ports.ts"),
  gatewayRelative("admin", "wiring.ts"),
  gatewayRelative("ingress", "api.ts"),
  gatewayRelative("ingress", "types.ts"),
  gatewayRelative("ingress", "ports.ts"),
  gatewayRelative("ingress", "wiring.ts"),
  gatewayRelative("hosted", "api.ts"),
  gatewayRelative("hosted", "session.ts"),
  gatewayRelative("hosted", "thread-loop.ts"),
  gatewayRelative("hosted", "provider.ts"),
  gatewayRelative("hosted", "compaction.ts"),
  gatewayRelative("channels", "api.ts"),
  gatewayRelative("channels", "types.ts"),
  gatewayRelative("channels", "ports.ts"),
  gatewayRelative("channels", "wiring.ts"),
  gatewayRelative("daemon", "api.ts"),
  gatewayRelative("daemon", "types.ts"),
  gatewayRelative("daemon", "ports.ts"),
  gatewayRelative("daemon", "wiring.ts"),
  gatewayRelative("delegation", "api.ts"),
  gatewayRelative("delegation", "types.ts"),
  gatewayRelative("delegation", "ports.ts"),
  gatewayRelative("delegation", "wiring.ts"),
  gatewayRelative("extensions", "api.ts"),
  gatewayRelative("protocol", "api.ts"),
  gatewayRelative("protocol", "types.ts"),
  gatewayRelative("protocol", "ports.ts"),
  gatewayRelative("protocol", "wiring.ts"),
  gatewayRelative("policy", "model-routing", "api.ts"),
  gatewayRelative("policy", "model-routing", "types.ts"),
  gatewayRelative("policy", "model-routing", "ports.ts"),
  gatewayRelative("policy", "model-routing", "wiring.ts"),
];

describe("gateway domain template", () => {
  test("pins template anchor files for public control-plane domains", () => {
    expect(expectGatewayFiles(required)).toEqual([]);
  });
});
