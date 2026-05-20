import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function collectSourceFiles(relativePath: string): string[] {
  const root = resolve(repoRoot, relativePath);
  const files: string[] = [];
  if (!existsSync(root)) return files;
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "dist" || entry.name === "node_modules") continue;
        walk(absolutePath);
        continue;
      }
      if (entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name)) {
        files.push(absolutePath);
      }
    }
  }
  walk(root);
  return files.toSorted();
}

function repoPath(absolutePath: string): string {
  return relative(repoRoot, absolutePath).replaceAll("\\", "/");
}

function readInterfaceBlock(source: string, name: string): string {
  const match = new RegExp(`export\\s+interface\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`, "u").exec(
    source,
  );
  if (!match?.[1]) {
    throw new Error(`Missing interface ${name}`);
  }
  return match[1];
}

describe("runtime protocol and tape surface fitness", () => {
  test("runtime package exports protocol data shapes without legacy contract subpaths", () => {
    const packageJson = JSON.parse(readRepoFile("packages/brewva-runtime/package.json")) as {
      exports?: Record<string, unknown>;
    };
    const exportKeys = Object.keys(packageJson.exports ?? {});

    expect(exportKeys).toContain("./protocol");
    expect(exportKeys).not.toContain("./legacy-contracts");
    expect(exportKeys).not.toContain("./contracts");
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/protocol.ts"))).toBe(true);
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/legacy-contracts.ts"))).toBe(
      false,
    );
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/contracts.ts"))).toBe(false);
  });

  test("repo-owned callers no longer import the retired contracts subpath", () => {
    const offenders = collectSourceFiles("packages")
      .concat(collectSourceFiles("test"))
      .filter((file) =>
        /from ["']@brewva\/brewva-runtime\/contracts["']/u.test(readFileSync(file, "utf8")),
      )
      .map(repoPath)
      .toSorted();

    expect(offenders).toEqual([]);
  });

  test("runtime internal source no longer imports local contracts.js", () => {
    const offenders = collectSourceFiles("packages/brewva-runtime/src")
      .filter((file) =>
        /from ["']\.\/contracts\.js["']|from ["']\.\.\/contracts\.js["']/u.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map(repoPath)
      .toSorted();

    expect(offenders).toEqual([]);
  });

  test("protocol contracts do not use retired LooseRecord or LegacyUncheckedRecord names", () => {
    const protocolRoot = readRepoFile("packages/brewva-runtime/src/protocol.ts");
    const body = readRepoFile("packages/brewva-runtime/src/protocol/body.ts");
    const looseRecordRefs =
      (protocolRoot.match(/\bLooseRecord\b/gu)?.length ?? 0) +
      (body.match(/\bLooseRecord\b/gu)?.length ?? 0);
    const legacyUncheckedRefs =
      (protocolRoot.match(/\bLegacyUncheckedRecord\b/gu)?.length ?? 0) +
      (body.match(/\bLegacyUncheckedRecord\b/gu)?.length ?? 0);

    expect(looseRecordRefs).toBe(0);
    expect(legacyUncheckedRefs).toBe(0);
    expect(body).not.toContain("type DynamicValue =");
    expect(body).not.toContain("Record<string, any>");
    expect(body).not.toMatch(/export type [A-Za-z0-9_]+ = ProtocolRecord;/u);
  });

  test("gateway runtime ops port does not expose a dynamic control-plane index", () => {
    const runtimeOps = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/session/runtime-ops.ts",
    );
    const daemonRecovery = readRepoFile("packages/brewva-gateway/src/daemon/recovery.ts");

    expect(runtimeOps).not.toContain("type DynamicValue =");
    expect(runtimeOps).not.toContain("type DynamicRecord =");
    expect(runtimeOps).not.toMatch(/interface HostedRuntimeOpsPort[\s\S]*?\[key: string\]/u);
    expect(runtimeOps).not.toMatch(/\}\s*&\s*DynamicRecord/u);
    expect(daemonRecovery).not.toContain("type DynamicValue =");
    expect(daemonRecovery).not.toContain("[key: string]: DynamicValue");
  });

  test("substrate no longer exposes the broad contracts package subpath", () => {
    const packageJson = JSON.parse(readRepoFile("packages/brewva-substrate/package.json")) as {
      exports?: Record<string, unknown>;
    };
    const offenders = collectSourceFiles("packages")
      .concat(collectSourceFiles("test"))
      .filter((file) =>
        /from ["']@brewva\/brewva-substrate\/contracts["']/u.test(readFileSync(file, "utf8")),
      )
      .map(repoPath)
      .toSorted();

    expect(Object.keys(packageJson.exports ?? {})).not.toContain("./contracts");
    expect(offenders).toEqual([]);
  });

  test("AGENTS.md forbids private runtime construction and Tape commit seams", () => {
    const agents = readRepoFile("AGENTS.md");

    expect(agents).not.toContain("runtime-assembly");
    expect(agents).toContain(
      "Do not add private runtime construction, Tape commit, or Effect semantic service seams",
    );
  });

  test("public TapePort no longer exposes search placeholders", () => {
    const runtimeApi = readRepoFile("packages/brewva-runtime/src/runtime/runtime-api.ts");
    const publicIndex = readRepoFile("packages/brewva-runtime/src/public/index.ts");
    const tapePort = readInterfaceBlock(runtimeApi, "TapePort");

    expect(tapePort).not.toContain("search(");
    expect(runtimeApi).not.toContain("interface TapeSearchQuery");
    expect(runtimeApi).not.toContain("interface TapeHit");
    expect(publicIndex).not.toContain("TapeSearchQuery");
    expect(publicIndex).not.toContain("TapeHit");
  });

  test("gateway adapters do not call runtime.tape.search on the public runtime", () => {
    const offenders = collectSourceFiles("packages/brewva-gateway/src")
      .filter((file) => /\.tape\.search\(/u.test(readFileSync(file, "utf8")))
      .map(repoPath)
      .toSorted();

    expect(offenders).toEqual([]);
  });
});
