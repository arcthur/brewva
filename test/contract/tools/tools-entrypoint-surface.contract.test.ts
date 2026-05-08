import { describe, expect, test } from "bun:test";

describe("brewva-tools public entrypoints", () => {
  test("keeps the root package surface narrow", async () => {
    const root = await import("@brewva/brewva-tools");

    expect(Object.keys(root).toSorted()).toEqual(["buildBrewvaTools"]);
  });

  test("exposes only explicit contract, registry, runtime-port, and family subpaths", async () => {
    const [
      contracts,
      registry,
      runtimePort,
      navigation,
      execution,
      memory,
      delegation,
      workflow,
      modelRouting,
    ] = await Promise.all([
      import("@brewva/brewva-tools/contracts"),
      import("@brewva/brewva-tools/registry"),
      import("@brewva/brewva-tools/runtime-port"),
      import("@brewva/brewva-tools/navigation"),
      import("@brewva/brewva-tools/execution"),
      import("@brewva/brewva-tools/memory"),
      import("@brewva/brewva-tools/delegation"),
      import("@brewva/brewva-tools/workflow"),
      import("@brewva/brewva-gateway/model-routing"),
    ]);

    expect(registry.MANAGED_BREWVA_TOOL_NAMES).toContain("grep");
    expect(typeof registry.createRuntimeBoundBrewvaToolFactory).toBe("function");
    expect(typeof runtimePort.withParallelReadSlot).toBe("function");
    expect(typeof navigation.createGrepTool).toBe("function");
    expect(typeof execution.createExecTool).toBe("function");
    expect(typeof memory.createRecallSearchTool).toBe("function");
    expect(typeof delegation.createSubagentRunTool).toBe("function");
    expect(typeof delegation.synthesizeReviewEnsemble).toBe("function");
    expect(typeof delegation.classifyReviewChangedFiles).toBe("function");
    expect(typeof workflow.createWorkflowStatusTool).toBe("function");
    expect("synthesizeReviewEnsemble" in workflow).toBe(false);
    expect("classifyReviewChangedFiles" in workflow).toBe(false);
    expect(typeof modelRouting.resolveBrewvaModelSelection).toBe("function");
    expect(typeof modelRouting.selectBrewvaFallbackModel).toBe("function");
    expect(Object.keys(contracts).toSorted()).toEqual([]);
  });

  test("rejects legacy tools subpaths instead of forwarding compatibility barrels", async () => {
    const legacySubpaths = [
      "@brewva/brewva-tools/bundle",
      "@brewva/brewva-tools/default-bundle",
      "@brewva/brewva-tools/factories",
      "@brewva/brewva-tools/model-routing",
      "@brewva/brewva-tools/types",
    ];

    for (const specifier of legacySubpaths) {
      let rejected = false;
      try {
        await import(specifier);
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    }
  });
});
