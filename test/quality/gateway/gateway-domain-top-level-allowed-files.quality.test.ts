import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { gatewayPath, listGatewayProductionFiles, readRepoFile } from "./shared.js";

function listDomainTopLevelFiles(...segments: string[]): string[] {
  return readdirSync(gatewayPath(...segments), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .toSorted();
}

function expectShrinkableRoot(
  domain: string,
  options: {
    maxTopLevelFiles: number;
    requiredFiles: readonly string[];
  },
): void {
  const files = listDomainTopLevelFiles(domain);
  expect(files.length).toBeLessThanOrEqual(options.maxTopLevelFiles);
  expect(files).toEqual(expect.arrayContaining([...options.requiredFiles]));
}

describe("gateway domain top-level allowed files", () => {
  test("locks already-internalized domain roots to seam files only", () => {
    expect(listDomainTopLevelFiles("admin")).toEqual([
      "api.ts",
      "ports.ts",
      "types.ts",
      "wiring.ts",
    ]);
    expect(listDomainTopLevelFiles("ingress")).toEqual([
      "api.ts",
      "ports.ts",
      "types.ts",
      "wiring.ts",
    ]);
    expect(listDomainTopLevelFiles("extensions")).toEqual(["api.ts"]);
    expect(listDomainTopLevelFiles("hosted")).toEqual([
      "api.ts",
      "compaction.ts",
      "context.ts",
      "provider.ts",
      "session.ts",
      "thread-loop.ts",
    ]);
  });

  test("keeps evolving domain roots shrinkable while preserving seam anchors", () => {
    expectShrinkableRoot("daemon", {
      maxTopLevelFiles: 11,
      requiredFiles: ["api.ts", "ports.ts", "types.ts", "wiring.ts"],
    });
    expectShrinkableRoot("delegation", {
      maxTopLevelFiles: 24,
      requiredFiles: ["api.ts", "ports.ts", "types.ts", "wiring.ts"],
    });
    expectShrinkableRoot("channels", {
      maxTopLevelFiles: 18,
      requiredFiles: ["api.ts", "ports.ts", "types.ts", "wiring.ts"],
    });
    expectShrinkableRoot("protocol", {
      maxTopLevelFiles: 6,
      requiredFiles: ["api.ts", "ports.ts", "types.ts", "wiring.ts"],
    });
  });

  test("keeps already-moved implementation files out of root directories", () => {
    expect(listDomainTopLevelFiles("daemon")).not.toContain("session-binding-tape.ts");
    expect(listDomainTopLevelFiles("daemon")).not.toContain("session-wire-status.ts");
    expect(listDomainTopLevelFiles("daemon")).not.toContain("service-manager.ts");
    expect(listDomainTopLevelFiles("delegation")).not.toContain("constitutions.ts");
    expect(listDomainTopLevelFiles("delegation")).not.toContain("background-controller.ts");
    expect(listDomainTopLevelFiles("delegation")).not.toContain("catalog.ts");
    expect(listDomainTopLevelFiles("delegation")).not.toContain("background-protocol.ts");
    expect(listDomainTopLevelFiles("channels")).not.toContain("channel-bootstrap.ts");
    expect(listDomainTopLevelFiles("protocol")).not.toContain("index.ts");
    expect(listDomainTopLevelFiles("hosted")).not.toContain("hosted-auth-store.ts");
    expect(listDomainTopLevelFiles("hosted")).not.toContain("compaction-summary-generator.ts");
    expect(listDomainTopLevelFiles("hosted")).not.toContain("worker-main.ts");
    expect(listDomainTopLevelFiles("hosted")).not.toContain("turn-envelope.ts");
    expect(
      readRepoFile("packages/brewva-gateway/src/daemon/session-supervisor/index.ts"),
    ).toContain("./session-binding-tape.js");
    expect(readRepoFile("packages/brewva-gateway/src/daemon/gateway-daemon.ts")).toContain(
      "./internal/session-wire-status.js",
    );
    expect(readRepoFile("packages/brewva-gateway/src/delegation/api.ts")).not.toContain(
      'from "./index.js"',
    );
    expect(readRepoFile("packages/brewva-gateway/src/delegation/catalog/registry.ts")).toContain(
      "./constitutions.js",
    );
    expect(readRepoFile("packages/brewva-gateway/src/delegation/api.ts")).toContain(
      'from "./catalog/registry.js"',
    );
    expect(readRepoFile("packages/brewva-gateway/src/admin/internal/cli.ts")).toContain(
      'from "./service-manager.js"',
    );
    expect(readRepoFile("packages/brewva-gateway/src/delegation/runner-main.ts")).toContain(
      'import "./background/runner-main.js"',
    );
    expect(readRepoFile("packages/brewva-gateway/src/delegation/api.ts")).toContain(
      'from "./background/controller.js"',
    );
  });

  test("keeps production source free of stale gateway implementation path anchors", () => {
    const stalePathAnchors = [
      "packages/brewva-gateway/src/subagents/",
      "packages/brewva-gateway/src/conversations/",
      "packages/brewva-gateway/src/cache/",
      "packages/brewva-gateway/src/host/",
      "packages/brewva-gateway/src/session/",
      "packages/brewva-gateway/src/runtime-plugins/",
    ];
    const offenders = listGatewayProductionFiles().flatMap((file) => {
      const source = readRepoFile(file);
      return stalePathAnchors
        .filter((anchor) => source.includes(anchor))
        .map((anchor) => ({ file, anchor }));
    });

    expect(offenders).toEqual([]);
  });
});
