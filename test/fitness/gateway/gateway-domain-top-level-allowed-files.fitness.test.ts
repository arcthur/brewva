import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { gatewayPath, readRepoFile } from "./shared.js";

const controlPlaneDomains = [
  "admin",
  "channels",
  "daemon",
  "delegation",
  "ingress",
  "protocol",
] as const;

function listDomainTopLevelFiles(...segments: string[]): string[] {
  return readdirSync(gatewayPath(...segments), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .toSorted();
}

describe("gateway domain top-level allowed files", () => {
  test("control-plane domains expose stable seam files", () => {
    const missingSeams = controlPlaneDomains.flatMap((domain) => {
      const files = new Set(listDomainTopLevelFiles(domain));
      return ["api.ts", "ports.ts", "types.ts", "wiring.ts"]
        .filter((file) => !files.has(file))
        .map((file) => `${domain}/${file}`);
    });

    expect(missingSeams).toEqual([]);
  });

  test("single-purpose public facades stay explicit", () => {
    expect(listDomainTopLevelFiles("extensions")).toEqual(["api.ts"]);
    expect(listDomainTopLevelFiles("harness")).toEqual(["api.ts"]);
  });

  test("policy domains expose stable seam files", () => {
    const files = new Set(listDomainTopLevelFiles("policy", "model-routing"));
    const missingSeams = ["api.ts", "ports.ts", "types.ts", "wiring.ts"].filter(
      (file) => !files.has(file),
    );

    expect(missingSeams).toEqual([]);
  });

  test("seam files declare a real export, not a content-less placeholder", () => {
    const seamFiles = ["api.ts", "ports.ts", "types.ts", "wiring.ts"] as const;
    const domainDirs: readonly (readonly string[])[] = [
      ...controlPlaneDomains.map((domain) => [domain] as const),
      ["policy", "model-routing"] as const,
    ];
    const contentless = domainDirs.flatMap((segments) =>
      seamFiles
        .filter(
          (file) =>
            !/^\s*export\b/mu.test(
              readRepoFile(["packages/brewva-gateway/src", ...segments, file].join("/")),
            ),
        )
        .map((file) => [...segments, file].join("/")),
    );

    expect(contentless).toEqual([]);
  });
});
