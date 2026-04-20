import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const EXPECTED_SYMBOLS = [
  "InternalRuntimePlugin",
  "InternalRuntimePluginApi",
  "RuntimePluginCapability",
  "LocalHookPort",
  "createHostedTurnPipeline",
  "TurnLifecyclePort",
  "registerTurnLifecyclePorts",
  "BrewvaRuntimeOptions",
  "cwd?",
  "configPath?",
  "config?",
  "governancePort?",
  "agentId?",
  "routingScopes?",
  "routingDefaultScopes?",
  "registerContextTransform",
  "registerEventStream",
  "registerQualityGate",
  "registerLedgerWriter",
  "registerToolResultDistiller",
  "registerCompletionGuard",
];

describe("docs/reference runtime plugins coverage", () => {
  it("documents runtime plugin entry points and handlers", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const markdown = readFileSync(resolve(repoRoot, "docs/reference/runtime-plugins.md"), "utf-8");

    const missing = EXPECTED_SYMBOLS.filter((name) => !markdown.includes(`\`${name}\``));

    expect(
      missing,
      `Missing runtime plugin symbols in docs/reference/runtime-plugins.md: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
