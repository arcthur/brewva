import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG, type BrewvaConfig } from "@brewva/brewva-runtime";
import { createTestWorkspace } from "../../helpers/workspace.js";

function createTruthSplitWorkspace(name: string): string {
  const workspace = createTestWorkspace(`truth-split-${name}`);
  writeFileSync(
    join(workspace, "AGENTS.md"),
    [
      "## CRITICAL RULES",
      "- User-facing command name is `brewva`.",
      "- Use workspace package imports `@brewva/brewva-runtime`.",
      "- Use Bun `1.3.12`.",
      "- Run bun run test:dist.",
    ].join("\n"),
    "utf8",
  );
  return workspace;
}

function createConfig(): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.infrastructure.toolFailureInjection.enabled = false;
  config.projection.enabled = false;
  return config;
}

describe("truth split channels", () => {
  test("keeps truth details out of default context injection while task ledger tracks active fact ids", async () => {
    const runtime = new BrewvaRuntime({
      cwd: createTruthSplitWorkspace("latest"),
      config: createConfig(),
      agentId: "default",
    });
    const sessionId = "truth-split-latest";

    runtime.authority.truth.upsertFact(sessionId, {
      id: "truth:1",
      kind: "diagnostic",
      severity: "warn",
      summary: "first dynamic fact",
    });

    const first = await runtime.maintain.context.buildInjection(
      sessionId,
      "first turn",
      undefined,
      { injectionScopeId: "scope-1" },
    );
    expect(first.accepted).toBe(true);
    expect(first.text).not.toContain("[TruthLedger]");
    expect(first.text).not.toContain("[TruthFacts]");
    expect(first.text).toContain("[TaskLedger]");
    expect(first.text).toContain("truth:1");
    expect(first.text).not.toContain("first dynamic fact");

    const second = await runtime.maintain.context.buildInjection(
      sessionId,
      "second turn",
      undefined,
      { injectionScopeId: "scope-2" },
    );
    expect(second.accepted).toBe(true);
    expect(second.text).not.toContain("[TruthLedger]");
    expect(second.text).not.toContain("[TruthFacts]");
    expect(second.text).toContain("truth:1");
    expect(second.text).not.toContain("first dynamic fact");

    runtime.authority.truth.upsertFact(sessionId, {
      id: "truth:2",
      kind: "diagnostic",
      severity: "warn",
      summary: "second dynamic fact",
    });

    const third = await runtime.maintain.context.buildInjection(
      sessionId,
      "third turn",
      undefined,
      { injectionScopeId: "scope-3" },
    );
    expect(third.accepted).toBe(true);
    expect(third.text).not.toContain("[TruthLedger]");
    expect(third.text).not.toContain("[TruthFacts]");
    expect(third.text).toContain("truth:1");
    expect(third.text).toContain("truth:2");
    expect(third.text).not.toContain("second dynamic fact");

    const activeFacts = runtime.inspect.truth
      .getState(sessionId)
      .facts.filter((fact) => fact.status === "active")
      .map((fact) => fact.id)
      .toSorted();
    expect(activeFacts).toEqual(["truth:1", "truth:2"]);
  });
});
