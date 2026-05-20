import { describe, expect, test } from "bun:test";
import { listGatewayProductionFiles, readRepoFile } from "./shared.js";

describe("hosted lane layout", () => {
  test("keeps the hosted package facade free of private owner internals", () => {
    const publicFacade = readRepoFile("packages/brewva-gateway/src/hosted/api.ts");
    for (const privateExport of [
      "createCompactReadTool",
      "createHostedSessionFactory",
      "createHostedToolExecutionCoordinator",
      "wrapToolDefinitionsWithHostedExecutionTraits",
      "applyWorkbenchEvictionsToMessages",
      "TURN_TRANSITION_TEST_ONLY",
      "HOSTED_PROMPT_ATTEMPT_DISPATCH",
      "ToolAttemptBindingRegistry",
      "registerProviderRequestRecovery",
      "registerProviderRequestReduction",
    ]) {
      expect(publicFacade).not.toContain(privateExport);
    }
  });

  test("keeps the extension facade opt-in and free of hosted behavior internals", () => {
    const facade = readRepoFile("packages/brewva-gateway/src/extensions/api.ts");
    expect(facade).toContain("HostedExtensionPlugin");
    expect(facade).toContain("defineHostedExtensionPlugin");
    expect(facade).toContain("LocalHookPort");
    expect(facade).not.toContain("createHostedBehaviorHostAdapter");
    expect(facade).not.toContain("registerProviderRequestRecovery");
    expect(facade).not.toContain("distillToolOutput");
    expect(facade).not.toContain("buildContextEvidenceReport");
  });

  test("keeps hosted behavior installation private to hosted session assembly", () => {
    const packageJson = JSON.parse(readRepoFile("packages/brewva-gateway/package.json")) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(packageJson.exports)).not.toContain("./host");
    expect(Object.keys(packageJson.exports)).not.toContain("./session");
    expect(Object.keys(packageJson.exports)).not.toContain("./runtime-plugins");
    expect(Object.keys(packageJson.exports)).not.toContain("./hosted/compaction");

    const sessionAssembly = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/session/init/orchestration.ts",
    );
    expect(sessionAssembly).toContain("createHostedBehaviorHostAdapter");
    const productionCallSites = listGatewayProductionFiles()
      .filter((file) => readRepoFile(file).includes("createHostedBehaviorHostAdapter({"))
      .filter(
        (file) =>
          file !== "packages/brewva-gateway/src/hosted/internal/session/host-api-installation.ts",
      )
      .toSorted();
    expect(productionCallSites).toEqual([
      "packages/brewva-gateway/src/hosted/internal/session/init/orchestration.ts",
    ]);
    expect(
      readRepoFile("packages/brewva-gateway/src/hosted/internal/session/host-api-installation.ts"),
    ).toContain("createHostedBehaviorHostAdapter");
  });

  test("keeps hosted context materialization side effects in the direct materialization owner", () => {
    const materializationPath =
      "packages/brewva-gateway/src/hosted/internal/context/materialization.ts";
    const materialization = readRepoFile(materializationPath);
    expect(materialization).toContain("buildContextMaterializationReceipt");
    expect(materialization).toContain("applyContextMaterializationReceipt");
    expect(materialization).toContain("observeHostedProviderCache");
    expect(materialization).toContain("rememberHostedVisibleReadState");
    expect(materialization).not.toContain("planHostedContextMaterialization");
    expect(materialization).not.toContain("commitHostedContextMaterialization");
    expect(materialization).not.toContain("HOSTED_CONTEXT_MATERIALIZATION_EFFECT_ORDER");
    for (const expectedReceiptField of [
      "usageObserved",
      "promptStability",
      "surfacedDelegationRunIds",
    ]) {
      expect(materialization).toContain(expectedReceiptField);
    }
    for (const removedEffectString of [
      "usage_observed",
      "provider_cache_observed",
      "visible_read_state_remembered",
      "prompt_stability_observed",
      "delegation_outcome_surfaced",
      "effects:",
    ]) {
      expect(materialization).not.toContain(removedEffectString);
    }

    const offenders = listGatewayProductionFiles()
      .filter((file) => file.startsWith("packages/brewva-gateway/src/hosted/"))
      .filter((file) => file !== materializationPath)
      .filter((file) => {
        const source = readRepoFile(file);
        return source.includes(".ops.context.visibleRead.rememberState(");
      })
      .toSorted();
    expect(offenders).toEqual([]);
  });

  test("keeps hosted receipt writers under declared internal owners", () => {
    const writerPatterns = [
      /\.extensions\.hosted\.events\.record\(/u,
      /\brecordSessionTurnTransition\(/u,
      /\bruntime\.authority\.tape\./u,
      /\.recordEvent\(/u,
    ];
    const writerCalls = listGatewayProductionFiles().filter((file) => {
      if (!file.startsWith("packages/brewva-gateway/src/hosted/")) return false;
      const source = readRepoFile(file);
      return writerPatterns.some((pattern) => pattern.test(source));
    });

    const allowedPrefixes = [
      "packages/brewva-gateway/src/hosted/internal/session/init/",
      "packages/brewva-gateway/src/hosted/internal/session/projection/",
      "packages/brewva-gateway/src/hosted/internal/provider/request/",
      "packages/brewva-gateway/src/hosted/internal/context/",
      "packages/brewva-gateway/src/hosted/internal/compaction/",
      "packages/brewva-gateway/src/hosted/internal/session/tools/",
      "packages/brewva-gateway/src/hosted/internal/turn-adapter/",
    ];
    const allowedFiles = new Set([
      "packages/brewva-gateway/src/hosted/internal/session/host-api-installation.ts",
      "packages/brewva-gateway/src/hosted/internal/session/managed-agent/session.ts",
    ]);
    const offenders = writerCalls.filter(
      (file) =>
        !allowedFiles.has(file) && !allowedPrefixes.some((prefix) => file.startsWith(prefix)),
    );
    expect(offenders).toEqual([]);
  });
});
