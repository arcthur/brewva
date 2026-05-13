import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("tui internal runtime contract", () => {
  test("keeps the public root Node-safe while exposing a Bun-only internal runtime seam", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const packageJsonPath = resolve(repoRoot, "packages", "brewva-tui", "package.json");
    const rootEntrypointPath = resolve(repoRoot, "packages", "brewva-tui", "src", "index.ts");
    const internalStubPath = resolve(
      repoRoot,
      "packages",
      "brewva-tui",
      "src",
      "internal-opentui-runtime.ts",
    );
    const runtimeEntrypointPath = resolve(
      repoRoot,
      "packages",
      "brewva-tui",
      "runtime",
      "internal-opentui-runtime.ts",
    );

    const packageJsonSource = readFileSync(packageJsonPath, "utf8");
    const rootEntrypointSource = readFileSync(rootEntrypointPath, "utf8");
    const internalStubSource = existsSync(internalStubPath)
      ? readFileSync(internalStubPath, "utf8")
      : "";
    const runtimeEntrypointSource = existsSync(runtimeEntrypointPath)
      ? readFileSync(runtimeEntrypointPath, "utf8")
      : "";

    expect(packageJsonSource).toContain('"./internal-opentui-runtime"');
    expect(packageJsonSource).toContain('"bun"');
    expect(packageJsonSource).toContain('"import"');
    expect(packageJsonSource).toContain('"types"');
    expect(rootEntrypointSource).not.toContain("@opentui/core");
    expect(rootEntrypointSource).not.toContain("bun:ffi");
    expect(internalStubSource).toContain("OpenTUI runtime is only available");
    expect(runtimeEntrypointSource).toContain("@opentui/core");
    expect(runtimeEntrypointSource).toContain("@opentui/solid");
    expect(packageJsonSource).not.toContain('"react"');
    expect(packageJsonSource).not.toContain('"react-reconciler"');
    expect(internalStubSource).not.toContain('from "react"');
    expect(runtimeEntrypointSource).not.toContain("opentui-react");
    expect(runtimeEntrypointSource).not.toContain('from "react"');
  });
});
