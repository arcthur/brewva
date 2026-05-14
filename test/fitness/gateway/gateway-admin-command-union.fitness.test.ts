import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { gatewayPath, readRepoFile } from "./shared.js";

const expectedKinds = [
  "help",
  "start",
  "install",
  "uninstall",
  "status",
  "stop",
  "scheduler-pause",
  "scheduler-resume",
  "heartbeat-reload",
  "rotate-token",
  "logs",
  "unknown",
] as const;

describe("gateway admin command union", () => {
  test("defines the control-plane command discriminant set in admin/types", () => {
    const source = readRepoFile("packages/brewva-gateway/src/admin/types.ts");
    for (const kind of expectedKinds) {
      expect(source).toContain(`kind: "${kind}"`);
    }
    expect(source).toContain("interface GatewayAdminPort");
  });

  test("routes admin exports through the dedicated admin seam", () => {
    const adminApi = readRepoFile("packages/brewva-gateway/src/admin/api.ts");
    const adminWiring = readRepoFile("packages/brewva-gateway/src/admin/wiring.ts");
    const adminCli = readRepoFile("packages/brewva-gateway/src/admin/internal/cli.ts");
    const ingressApi = readRepoFile("packages/brewva-gateway/src/ingress/api.ts");
    const ingressWiring = readRepoFile("packages/brewva-gateway/src/ingress/wiring.ts");
    const cliEntry = readRepoFile("packages/brewva-cli/src/entry/main.ts");
    expect(adminApi).toContain('from "./internal/cli.js"');
    expect(adminWiring).toContain('from "./internal/cli.js"');
    expect(adminCli).toContain("resolveGatewayAdminCommand");
    expect(adminCli).toContain("const handlers = {");
    expect(ingressApi).toContain('from "../admin/api.js"');
    expect(ingressWiring).toContain('from "./internal/client.js"');
    expect(ingressWiring).toContain('from "./internal/auth.js"');
    expect(ingressWiring).toContain('from "./internal/network.js"');
    expect(existsSync(gatewayPath("ingress", "internal", "cli.ts"))).toBeFalse();
    expect(cliEntry).toContain("@brewva/brewva-gateway/admin");
  });
});
