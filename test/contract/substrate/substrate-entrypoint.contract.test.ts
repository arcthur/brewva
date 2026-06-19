import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");

describe("substrate entrypoint surface", () => {
  test("exports only contract-first substrate vocabulary from the root entrypoint", async () => {
    const substrate = await import("@brewva/brewva-substrate");

    expect(substrate.SESSION_PHASE_KINDS).toContain("model_streaming");
    expect(typeof substrate.isSessionPhaseActive).toBe("function");
    expect(substrate.DEFAULT_CONTEXT_STATE.budgetPressure).toBe("none");
    expect(substrate.BREWVA_THINKING_LEVELS).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);

    expect("buildBrewvaPromptText" in substrate).toBe(false);
    expect("createHostedResourceLoader" in substrate).toBe(false);
    expect("defineBrewvaTool" in substrate).toBe(false);
    expect("TOOL_EXECUTION_PHASES" in substrate).toBe(false);
    expect("createBrewvaReadToolDefinition" in substrate).toBe(false);
    expect("createBrewvaHostPluginRunner" in substrate).toBe(false);
    expect("readSessionBundleArtifact" in substrate).toBe(false);
    expect("createInMemoryModelCatalog" in substrate).toBe(false);
    expect("createBrewvaAgentProtocolController" in substrate).toBe(false);
    expect("createBrewvaInMemoryAgentSession" in substrate).toBe(false);
    expect("createBrewvaSyntheticSourceInfo" in substrate).toBe(false);
    expect("createBrewvaEventBus" in substrate).toBe(false);
    expect("buildBrewvaDeterministicCompactionSummary" in substrate).toBe(false);
  });

  test("does not expose a broad contracts subpath", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(repoRoot, "packages/brewva-substrate/package.json"), "utf8"),
    ) as { readonly exports?: Record<string, unknown> };

    expect(Object.hasOwn(packageJson.exports ?? {}, "./contracts")).toBe(false);
  });

  test("exports session mechanisms only from the explicit session subpath", async () => {
    const session = await import("@brewva/brewva-substrate/session");
    const sessionApi = readFileSync(
      resolve(repoRoot, "packages/brewva-substrate/src/session/api.ts"),
      "utf8",
    );

    // The low-level turn loop was internalized into runtime.turn; substrate no
    // longer ships a session-host orchestration bypass on this subpath.
    expect("createInMemorySessionHost" in session).toBe(false);
    expect(sessionApi).not.toContain("BrewvaPromptEnvelope");
    expect(typeof session.BrewvaManagedSessionStore).toBe("function");
    expect(typeof session.advanceSessionPhaseResult).toBe("function");
    expect(session.SESSION_CRASH_POINTS).toContain("tool_executing");
  });

  test("exports prompt mechanisms only from the explicit prompt subpath", async () => {
    const prompt = await import("@brewva/brewva-substrate/prompt");

    expect(typeof prompt.buildBrewvaPromptText).toBe("function");
    expect(typeof prompt.expandBrewvaPromptTemplate).toBe("function");
    expect(typeof prompt.buildBrewvaSystemPromptDocument).toBe("function");
    expect(typeof prompt.renderBrewvaSystemPromptText).toBe("function");
    expect(typeof prompt.appendBrewvaSystemPromptTextSection).toBe("function");
    expect(typeof prompt.renderBrewvaSystemPromptEnvironmentBlockText).toBe("function");
    expect(typeof prompt.buildBrewvaCapabilitySelectionPromptBlock).toBe("function");
    expect("buildBrewvaSystemPrompt" in prompt).toBe(false);
  });

  test("exports resource loading only from the explicit resources subpath", async () => {
    const resources = await import("@brewva/brewva-substrate/resources");

    expect(typeof resources.createHostedResourceLoader).toBe("function");
    expect("discoverSkills" in resources).toBe(false);
  });

  test("exports compaction mechanisms only from the explicit compaction subpath", async () => {
    const compaction = await import("@brewva/brewva-substrate/compaction");

    expect(typeof compaction.buildBrewvaDeterministicCompactionSummary).toBe("function");
    expect(typeof compaction.findBrewvaCompactionCutPoint).toBe("function");
    expect(compaction.BREWVA_COMPACTION_SUMMARY_HEADER).toBe("[CompactSummary]");
    expect(compaction.BREWVA_EMERGENCY_COMPACTION_SUMMARY_HEADER).toBe(
      "[CompactSummary][EmergencyFallback]",
    );
  });

  test("exports context-budget derivation only from the explicit context-budget subpath", async () => {
    const contextBudget = await import("@brewva/brewva-substrate/context-budget");

    expect(typeof contextBudget.deriveContextBudgetState).toBe("function");
    expect(typeof contextBudget.decideCompaction).toBe("function");
    expect("deriveContextBudgetState" in (await import("@brewva/brewva-substrate"))).toBe(false);
  });

  test("exports tool mechanisms only from the explicit tools subpath", async () => {
    const tools = await import("@brewva/brewva-substrate/tools");

    expect(typeof tools.defineBrewvaTool).toBe("function");
    expect(typeof tools.createBrewvaReadToolDefinition).toBe("function");
    expect(typeof tools.createBrewvaWriteToolDefinition).toBe("function");
    expect(typeof tools.createBrewvaEditToolDefinition).toBe("function");
    expect(tools.TOOL_EXECUTION_PHASES).toContain("cleanup");
  });

  test("exports host plugin mechanisms only from the explicit host-api subpath", async () => {
    const hostApi = await import("@brewva/brewva-substrate/host-api");

    expect(typeof hostApi.createBrewvaHostPluginRunner).toBe("function");
    expect(typeof hostApi.defineInternalHostPlugin).toBe("function");
    expect(typeof hostApi.resolveShellConfig).toBe("function");
    expect(typeof hostApi.normalizeQuestionPrompt).toBe("function");
  });

  test("exports provider driver mechanisms only from the explicit provider subpath", async () => {
    const provider = await import("@brewva/brewva-substrate/provider");

    expect(typeof provider.createInMemoryModelCatalog).toBe("function");
    expect(typeof provider.UnsupportedBrewvaProviderApiError).toBe("function");
    expect("createFetchProviderCompletionDriver" in provider).toBe(false);
  });

  test("exports agent protocol vocabulary without a public turn owner", async () => {
    const agentProtocol = await import("@brewva/brewva-substrate/agent-protocol");

    expect(typeof agentProtocol.convertToLlm).toBe("function");
    expect("createBrewvaAgentProtocolController" in agentProtocol).toBe(false);
    expect("runBrewvaAgentProtocol" in agentProtocol).toBe(false);
    expect("createBrewvaTurnProviderStreamFunction" in agentProtocol).toBe(false);
  });

  test("does not export substrate session composition as a public turn-loop bypass", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(repoRoot, "packages/brewva-substrate/package.json"), "utf8"),
    ) as {
      exports?: Record<string, unknown>;
    };

    expect(Object.keys(packageJson.exports ?? {})).not.toContain("./sdk");
    expect(Object.keys(packageJson.exports ?? {})).not.toContain("./turn");
    expect(Object.keys(packageJson.exports ?? {})).toContain("./agent-protocol");
  });

  test("does not expose zero-consumer mechanism subpaths as public API (WS5)", () => {
    // persistence/provenance/execution had no external production consumers and
    // were recovered from the public surface per the single-consumer seam
    // principle. Their implementations stay substrate-internal (consumed via
    // relative paths); re-export them only if a real second consumer appears.
    const packageJson = JSON.parse(
      readFileSync(resolve(repoRoot, "packages/brewva-substrate/package.json"), "utf8"),
    ) as { exports?: Record<string, unknown> };

    const exportKeys = Object.keys(packageJson.exports ?? {});
    expect(exportKeys).not.toContain("./persistence");
    expect(exportKeys).not.toContain("./provenance");
    expect(exportKeys).not.toContain("./execution");
  });
});
