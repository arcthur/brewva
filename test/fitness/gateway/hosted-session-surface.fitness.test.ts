import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");

function collectSourceFiles(relativePath: string): string[] {
  const files: string[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "dist" || entry.name === "node_modules") continue;
        walk(absolutePath);
        continue;
      }
      if (entry.isFile() && /\.(?:ts|tsx|json)$/u.test(entry.name)) {
        files.push(absolutePath);
      }
    }
  }
  walk(resolve(repoRoot, relativePath));
  return files.toSorted();
}

function repoPath(absolutePath: string): string {
  return relative(repoRoot, absolutePath).replaceAll("\\", "/");
}

describe("gateway hosted session fitness", () => {
  test("hosted session code is Brewva-owned and does not depend on Pi runtime packages", () => {
    const forbiddenPiReferences = [
      "@mariozechner/pi-agent-core",
      "@mariozechner/pi-ai",
      "@mariozechner/pi-coding-agent",
      "createHostedPi",
      "createPiHosted",
      "pi-session-runtime",
      "pi-hosted-session-backend",
    ];
    const offenders: string[] = [];

    for (const sourceFile of [
      ...collectSourceFiles("packages/brewva-gateway/src/hosted"),
      resolve(repoRoot, "packages/brewva-gateway/package.json"),
    ]) {
      if (!statSync(sourceFile).isFile()) continue;
      const source = readFileSync(sourceFile, "utf8");
      const matched = forbiddenPiReferences.filter((reference) => source.includes(reference));
      if (matched.length > 0) {
        offenders.push(`${repoPath(sourceFile)} -> ${matched.join(", ")}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("hosted sessions consume substrate turn-loop and provider-core contracts", () => {
    const managedSessionSource = readFileSync(
      resolve(
        repoRoot,
        "packages/brewva-gateway/src/hosted/internal/session/managed-agent/session.ts",
      ),
      "utf8",
    );
    const providerStreamSource = readFileSync(
      resolve(repoRoot, "packages/brewva-gateway/src/hosted/internal/provider/stream.ts"),
      "utf8",
    );
    const substratePackageSource = readFileSync(
      resolve(repoRoot, "packages/brewva-substrate/package.json"),
      "utf8",
    );

    expect(managedSessionSource).toContain("@brewva/brewva-substrate/turn");
    expect(providerStreamSource).toContain("@brewva/brewva-provider-core/stream");
    expect(providerStreamSource).toContain("@brewva/brewva-provider-core/contracts");
    expect(substratePackageSource).toContain('"./turn"');
  });
});
