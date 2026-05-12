import { describe, expect, test } from "bun:test";
import { expectGatewayFiles, readRepoFile } from "../gateway/shared.js";

describe("gateway ingress path anchors", () => {
  test("keeps stable docs aligned with admin and ingress control-plane paths", () => {
    expect(
      expectGatewayFiles([
        "packages/brewva-gateway/src/admin/api.ts",
        "packages/brewva-gateway/src/admin/internal/cli.ts",
        "packages/brewva-gateway/src/ingress/api.ts",
        "packages/brewva-gateway/src/ingress/internal/client.ts",
        "packages/brewva-gateway/src/ingress/internal/network.ts",
      ]),
    ).toEqual([]);

    const protocol = readRepoFile("docs/reference/gateway-control-plane-protocol.md");
    const commands = readRepoFile("docs/reference/commands.md");
    const daemonGuide = readRepoFile("docs/guide/gateway-control-plane-daemon.md");
    const lifecycleJourney = readRepoFile(
      "docs/journeys/operator/gateway-control-plane-lifecycle.md",
    );
    const schedulingJourney = readRepoFile("docs/journeys/operator/intent-driven-scheduling.md");

    expect(protocol).toContain("packages/brewva-gateway/src/ingress/internal/network.ts");
    expect(protocol).toContain("packages/brewva-gateway/src/ingress/internal/client.ts");
    expect(protocol).toContain("packages/brewva-gateway/src/admin/internal/cli.ts");
    expect(commands).toContain("packages/brewva-gateway/src/admin/internal/cli.ts");
    expect(daemonGuide).toContain("packages/brewva-gateway/src/ingress/internal/client.ts");
    expect(daemonGuide).toContain("packages/brewva-gateway/src/admin/internal/cli.ts");
    expect(lifecycleJourney).toContain("packages/brewva-gateway/src/admin/internal/cli.ts");
    expect(lifecycleJourney).toContain("packages/brewva-gateway/src/ingress/internal/client.ts");
    expect(schedulingJourney).toContain("packages/brewva-gateway/src/admin/internal/cli.ts");

    for (const legacy of [
      "packages/brewva-gateway/src/cli.ts",
      "packages/brewva-gateway/src/client.ts",
      "packages/brewva-gateway/src/network.ts",
      "packages/brewva-gateway/src/ingress/internal/cli.ts",
    ]) {
      expect(protocol).not.toContain(legacy);
      expect(commands).not.toContain(legacy);
      expect(daemonGuide).not.toContain(legacy);
      expect(lifecycleJourney).not.toContain(legacy);
      expect(schedulingJourney).not.toContain(legacy);
    }
  });
});
