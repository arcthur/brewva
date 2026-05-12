import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const EXPECTED_SYMBOLS = [
  "HostedExtensionPlugin",
  "HostedExtensionApi",
  "HostedExtensionCapability",
  "defineHostedExtensionPlugin",
  "LocalHookPort",
];

const DISALLOWED_ANCHORS = [
  "packages/brewva-gateway/src/hosted/internal/session/turn-lifecycle-port.ts",
  "packages/brewva-gateway/src/hosted/internal/session/event-stream.ts",
  "packages/brewva-gateway/src/hosted/internal/session/ledger-writer.ts",
  "packages/brewva-gateway/src/hosted/internal/session/tool-result-distiller.ts",
  "packages/brewva-gateway/src/hosted/internal/session/tool-surface.ts",
  "packages/brewva-gateway/src/hosted/internal/session/context-transform.ts",
  "packages/brewva-gateway/src/hosted/internal/session/workbench-context.ts",
  "packages/brewva-gateway/src/hosted/internal/session/hosted-context-telemetry.ts",
  "packages/brewva-gateway/src/hosted/internal/provider/request/provider-request-reduction.ts",
  "packages/brewva-gateway/src/hosted/internal/provider/request/provider-request-recovery.ts",
  "packages/brewva-gateway/src/hosted/internal/session/quality-gate.ts",
  "packages/brewva-gateway/src/hosted/internal/session/",
  "packages/brewva-gateway/src/hosted/internal/thread-loop/",
  "packages/brewva-gateway/src/hosted/internal/provider/",
  "packages/brewva-gateway/src/hosted/internal/compaction/",
  "packages/brewva-gateway/src/hosted/internal/context/",
  "createHostedBehaviorHostAdapter",
  "InternalRuntimePlugin",
  "defineInternalRuntimePlugin",
  "createHostedTurnPipeline",
  "@brewva/brewva-gateway/runtime-plugins",
  "defineEffectInternalHostPlugin",
  "EffectInternalHostPluginApi",
];

describe("docs/reference extensions coverage", () => {
  it("documents extension entry points without hosted behavior internals", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const markdown = readFileSync(resolve(repoRoot, "docs/reference/extensions.md"), "utf-8");

    const missing = EXPECTED_SYMBOLS.filter((name) => !markdown.includes(`\`${name}\``));

    expect(
      missing,
      `Missing extension symbols in docs/reference/extensions.md: ${missing.join(", ")}`,
    ).toEqual([]);

    for (const anchor of DISALLOWED_ANCHORS) {
      expect(markdown).not.toContain(anchor);
    }
  });
});
