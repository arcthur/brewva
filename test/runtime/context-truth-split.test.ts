import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG, type BrewvaConfig } from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-truth-split-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  writeFileSync(
    join(workspace, "AGENTS.md"),
    [
      "## CRITICAL RULES",
      "- User-facing command name is `brewva`.",
      "- Use workspace package imports `@brewva/brewva-runtime`.",
      "- Use Bun `1.3.9`.",
      "- Run bun run test:dist.",
    ].join("\n"),
    "utf8",
  );
  return workspace;
}

function createConfig(): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.infrastructure.toolFailureInjection.enabled = false;
  config.memory.enabled = false;
  return config;
}

describe("truth split channels", () => {
  test("keeps truth ledger once-per-session and refreshes dynamic facts across turns", async () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("latest"),
      config: createConfig(),
      agentId: "default",
    });
    const sessionId = "truth-split-latest";

    runtime.truth.upsertFact(sessionId, {
      id: "truth:1",
      kind: "diagnostic",
      severity: "warn",
      summary: "first dynamic fact",
    });

    const first = await runtime.context.buildInjection(
      sessionId,
      "first turn",
      undefined,
      "scope-1",
    );
    expect(first.accepted).toBe(true);
    expect(first.text.includes("[TruthLedger]")).toBe(true);
    expect(first.text.includes("[TruthFacts]")).toBe(true);
    expect(first.text.includes("first dynamic fact")).toBe(true);

    const second = await runtime.context.buildInjection(
      sessionId,
      "second turn",
      undefined,
      "scope-2",
    );
    expect(second.accepted).toBe(true);
    expect(second.text.includes("[TruthLedger]")).toBe(false);
    expect(second.text.includes("[TruthFacts]")).toBe(true);
    expect(second.text.includes("first dynamic fact")).toBe(true);

    runtime.truth.upsertFact(sessionId, {
      id: "truth:2",
      kind: "diagnostic",
      severity: "warn",
      summary: "second dynamic fact",
    });

    const third = await runtime.context.buildInjection(
      sessionId,
      "third turn",
      undefined,
      "scope-3",
    );
    expect(third.accepted).toBe(true);
    expect(third.text.includes("[TruthLedger]")).toBe(false);
    expect(third.text.includes("[TruthFacts]")).toBe(true);
    expect(third.text.includes("second dynamic fact")).toBe(true);
  });
});
