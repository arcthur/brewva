import { describe, expect, test } from "bun:test";

describe("runtime internal entrypoint", () => {
  test("keeps skill validation assembly primitives runtime-owned while removing the catch-all subpath", async () => {
    const runtime = await import("@brewva/brewva-runtime");
    const internalEntrypoint = "@brewva/brewva-runtime/internal" as string;

    let rejected = false;
    try {
      await import(internalEntrypoint);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect("SkillValidationContextBuilder" in runtime).toBe(false);
    expect("SkillOutputValidationPipeline" in runtime).toBe(false);
    expect("ContractValidator" in runtime).toBe(false);
    expect("PlanningOutputValidator" in runtime).toBe(false);
    expect("ImplementationOutputValidator" in runtime).toBe(false);
    expect("ReviewOutputValidator" in runtime).toBe(false);
    expect("QaOutputValidator" in runtime).toBe(false);
    expect("getSemanticArtifactOutputContract" in runtime).toBe(false);
    expect("renderSemanticArtifactExample" in runtime).toBe(false);
  });
});
