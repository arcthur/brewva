import { describe, expect, test } from "bun:test";
import { expectGatewayFiles, readRepoFile } from "../gateway/shared.js";

describe("gateway stable path anchors", () => {
  test("keeps stable docs aligned with host and delegation paths", () => {
    expect(
      expectGatewayFiles([
        "packages/brewva-gateway/src/hosted/api.ts",
        "packages/brewva-gateway/src/delegation/api.ts",
        "packages/brewva-gateway/src/delegation/orchestrator.ts",
        "packages/brewva-gateway/src/delegation/catalog/registry.ts",
        "packages/brewva-gateway/src/delegation/delegation-records.ts",
        "packages/brewva-gateway/src/delegation/execution-plan.ts",
        "packages/brewva-gateway/src/delegation/run-finalization.ts",
        "packages/brewva-gateway/src/delegation/skill-validation.ts",
        "packages/brewva-gateway/src/delegation/target-resolution.ts",
        "packages/brewva-gateway/src/delegation/background/controller.ts",
        "packages/brewva-gateway/src/delegation/background/protocol.ts",
        "packages/brewva-gateway/src/delegation/background/runner-main.ts",
        "packages/brewva-gateway/src/delegation/workspace.ts",
        "packages/brewva-gateway/src/delegation/delegation-store.ts",
      ]),
    ).toEqual([]);

    const docsIndex = readRepoFile("docs/index.md");
    const workerEvents = readRepoFile("docs/reference/events/workers.md");
    const backgroundJourney = readRepoFile("docs/journeys/operator/background-and-parallelism.md");

    expect(docsIndex).toContain("packages/brewva-gateway/src/hosted/api.ts");
    expect(docsIndex).toContain("packages/brewva-gateway/src/delegation");
    expect(workerEvents).toContain("packages/brewva-gateway/src/delegation");
    expect(backgroundJourney).toContain("packages/brewva-gateway/src/delegation/orchestrator.ts");
    expect(backgroundJourney).not.toContain("packages/brewva-gateway/src/subagents/");
    expect(docsIndex).not.toContain("packages/brewva-gateway/src/subagents");
    expect(workerEvents).not.toContain("packages/brewva-gateway/src/subagents");
  });
});
