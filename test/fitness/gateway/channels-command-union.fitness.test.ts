import { describe, expect, test } from "bun:test";
import { listGatewayProductionFiles, readRepoFile } from "./shared.js";

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

  test("routes channel control handling through public ports and command seams", () => {
    const api = readRepoFile("packages/brewva-gateway/src/channels/api.ts");
    const router = readRepoFile("packages/brewva-gateway/src/channels/command/router.ts");
    const ports = readRepoFile("packages/brewva-gateway/src/channels/ports.ts");
    const seam = readRepoFile("packages/brewva-gateway/src/channels/control-command.ts");

    expect(router).toContain("resolveChannelControlCommand");
    expect(router).toContain("isPublicChannelControlCommand");
    expect(ports).toContain("interface ChannelSessionPromptPort");
    expect(ports).toContain("interface ChannelOperatorCommandPort");
    expect(ports).not.toContain("../host/api.js");
    expect(ports).not.toContain("./channel-agent-dispatch.js");
    expect(api).not.toContain("ConversationBindingStore");
    expect(api).toContain('from "./ports.js"');
    expect(api).toContain('from "./command/contracts.js"');
    expect(api).toContain('from "./command/parser.js"');
    expect(seam).toContain('case "status"');
    expect(seam).toContain('case "route-agent"');

    const commandDomainViolations = listGatewayProductionFiles()
      .filter((file) => file.includes("/channels/command/"))
      .filter((file) => /from\s+["'](?:\.\.\/)+(?:host|hosted|daemon)\//u.test(readRepoFile(file)));
    expect(commandDomainViolations).toEqual([]);
  });
});
