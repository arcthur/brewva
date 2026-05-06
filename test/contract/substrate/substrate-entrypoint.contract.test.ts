import { describe, expect, test } from "bun:test";

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

    expect("createInMemorySessionHost" in substrate).toBe(false);
    expect("buildBrewvaPromptText" in substrate).toBe(false);
    expect("createHostedResourceLoader" in substrate).toBe(false);
    expect("defineBrewvaTool" in substrate).toBe(false);
    expect("TOOL_EXECUTION_PHASES" in substrate).toBe(false);
    expect("createBrewvaReadToolDefinition" in substrate).toBe(false);
    expect("createBrewvaHostPluginRunner" in substrate).toBe(false);
    expect("readSessionBundleArtifact" in substrate).toBe(false);
    expect("createInMemoryModelCatalog" in substrate).toBe(false);
    expect("createBrewvaTurnLoopController" in substrate).toBe(false);
    expect("createBrewvaInMemoryAgentSession" in substrate).toBe(false);
    expect("createBrewvaSyntheticSourceInfo" in substrate).toBe(false);
    expect("createBrewvaEventBus" in substrate).toBe(false);
    expect("buildBrewvaDeterministicCompactionSummary" in substrate).toBe(false);
  });

  test("exports contract-first vocabulary from the explicit contracts subpath", async () => {
    const contracts = await import("@brewva/brewva-substrate/contracts");

    expect(contracts.SESSION_TERMINATION_REASONS).toContain("host_closed");
    expect(typeof contracts.canResumeSessionPhase).toBe("function");
    expect(contracts.DEFAULT_CONTEXT_STATE.budgetPressure).toBe("none");
    expect(contracts.BREWVA_THINKING_LEVELS).toContain("xhigh");
    expect("defineBrewvaTool" in contracts).toBe(false);
    expect("advanceToolExecutionPhase" in contracts).toBe(false);
  });

  test("exports session mechanisms only from the explicit session subpath", async () => {
    const session = await import("@brewva/brewva-substrate/session");

    expect(typeof session.createInMemorySessionHost).toBe("function");
    expect(typeof session.BrewvaManagedSessionStore).toBe("function");
    expect(typeof session.advanceSessionPhaseResult).toBe("function");
    expect(session.SESSION_CRASH_POINTS).toContain("tool_executing");
  });

  test("exports prompt mechanisms only from the explicit prompt subpath", async () => {
    const prompt = await import("@brewva/brewva-substrate/prompt");

    expect(typeof prompt.buildBrewvaPromptText).toBe("function");
    expect(typeof prompt.expandBrewvaPromptTemplate).toBe("function");
    expect(typeof prompt.buildBrewvaSystemPrompt).toBe("function");
  });

  test("exports resource loading only from the explicit resources subpath", async () => {
    const resources = await import("@brewva/brewva-substrate/resources");

    expect(typeof resources.createHostedResourceLoader).toBe("function");
    expect("discoverSkills" in resources).toBe(false);
  });

  test("exports source provenance only from the explicit provenance subpath", async () => {
    const provenance = await import("@brewva/brewva-substrate/provenance");

    expect(typeof provenance.createBrewvaSyntheticSourceInfo).toBe("function");
    expect(provenance.BREWVA_SOURCE_SCOPES).toContain("runtime-plugin");
  });

  test("exports execution primitives only from the explicit execution subpath", async () => {
    const execution = await import("@brewva/brewva-substrate/execution");

    expect(typeof execution.createBrewvaEventBus).toBe("function");
    expect(execution.TOOL_EXECUTION_PHASES).toContain("cleanup");
  });

  test("exports compaction mechanisms only from the explicit compaction subpath", async () => {
    const compaction = await import("@brewva/brewva-substrate/compaction");

    expect(typeof compaction.buildBrewvaDeterministicCompactionSummary).toBe("function");
    expect(typeof compaction.findBrewvaCompactionCutPoint).toBe("function");
    expect(compaction.BREWVA_COMPACTION_SUMMARY_HEADER).toBe("[CompactSummary]");
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

  test("exports persistence helpers only from the explicit persistence subpath", async () => {
    const persistence = await import("@brewva/brewva-substrate/persistence");

    expect(typeof persistence.assertSessionBundleManifest).toBe("function");
    expect(typeof persistence.readSessionBundleArtifact).toBe("function");
  });

  test("exports provider driver mechanisms only from the explicit provider subpath", async () => {
    const provider = await import("@brewva/brewva-substrate/provider");

    expect(typeof provider.createInMemoryModelCatalog).toBe("function");
    expect(typeof provider.createFetchProviderCompletionDriver).toBe("function");
    expect(typeof provider.UnsupportedBrewvaProviderApiError).toBe("function");
  });

  test("exports the turn loop only from the explicit turn subpath", async () => {
    const turn = await import("@brewva/brewva-substrate/turn");

    expect(typeof turn.createBrewvaTurnLoopController).toBe("function");
    expect(typeof turn.runBrewvaTurnLoop).toBe("function");
    expect(typeof turn.createBrewvaTurnProviderStreamFunction).toBe("function");
  });

  test("exports substrate session composition only from the explicit sdk subpath", async () => {
    const sdk = await import("@brewva/brewva-substrate/sdk");

    expect(typeof sdk.createBrewvaSessionServices).toBe("function");
    expect(typeof sdk.createBrewvaSessionFromServices).toBe("function");
    expect(typeof sdk.createBrewvaInMemoryAgentSession).toBe("function");
  });
});
