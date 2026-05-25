import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

describe("runtime observation boundary fitness", () => {
  test("keeps observation as a kernel seam instead of a fifth root port", () => {
    const runtimeApi = readRepoFile("packages/brewva-runtime/src/runtime/runtime-api.ts");
    const kernelPort = readRepoFile("packages/brewva-runtime/src/runtime/kernel/port.ts");
    const runtimeRoot = runtimeApi.match(/export interface BrewvaRuntime \{(?<body>[\s\S]*?)\n\}/u)
      ?.groups?.["body"];

    expect(runtimeApi).toContain("KernelInterceptPort");
    expect(kernelPort).toContain("export interface KernelInterceptPort");
    expect(kernelPort).toContain("readonly intercept: KernelInterceptPort");
    expect(runtimeRoot).toContain("readonly kernel: KernelPort;");
    expect(runtimeRoot).not.toContain("harness");
    expect(runtimeRoot).not.toContain("observe");
    expect(runtimeRoot).not.toContain("intercept");
  });

  test("keeps shadow evidence out of the canonical event vocabulary", () => {
    const kernelPort = readRepoFile("packages/brewva-runtime/src/runtime/kernel/port.ts");

    expect(kernelPort).toContain('readonly mode: "shadow";');
    expect(kernelPort).toContain('readonly stage: "tool.authority";');
    expect(kernelPort).not.toContain('"shadow.observed"');
    expect(kernelPort).not.toContain('"kernel.shadow"');
  });

  test("requires explicit shadow physics and isolates interceptor failures", () => {
    const kernel = readRepoFile("packages/brewva-runtime/src/runtime/kernel/impl.ts");

    expect(kernel).toContain("input.shadowPhysics?.resolveToolAuthority");
    expect(kernel).toContain("kernel_shadow_tool_authority_requires_shadow_physics");
    expect(kernel).toContain("catch (error)");
    expect(kernel).toContain("appendShadowEvidence(shadowEvidence");
    expect(kernel).toContain("MAX_SHADOW_EVIDENCE_ENTRIES");
  });
});
