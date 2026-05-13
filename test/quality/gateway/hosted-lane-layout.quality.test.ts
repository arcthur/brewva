import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gatewayPath, listGatewayProductionFiles, readRepoFile, repoRoot } from "./shared.js";

function topLevelFiles(...segments: string[]): string[] {
  return readdirSync(gatewayPath(...segments), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .toSorted();
}

function topLevelDirectories(...segments: string[]): string[] {
  return readdirSync(gatewayPath(...segments), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
}

function listRepoTypeScriptFiles(...roots: string[]): string[] {
  const files: string[] = [];
  const visit = (relativeDir: string): void => {
    for (const entry of readdirSync(join(repoRoot, relativeDir), { withFileTypes: true })) {
      const relativePath = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        visit(relativePath);
      } else if (entry.isFile() && relativePath.endsWith(".ts")) {
        files.push(relativePath);
      }
    }
  };
  for (const root of roots) {
    visit(root);
  }
  return files.toSorted();
}

function isPassThroughReExport(source: string): boolean {
  const withoutImports = source
    .replace(/^\s*import\s+["'][^"']+["'];?\s*$/gmu, "")
    .replace(/^\s*import[\s\S]*?\s+from\s+["'][^"']+["'];?\s*$/gmu, "");
  const withoutExports = withoutImports
    .replace(/^\s*export\s+\*\s+from\s+["'][^"']+["'];?\s*$/gmu, "")
    .replace(/^\s*export\s+(?:type\s+)?\{[\s\S]*?\}\s+from\s+["'][^"']+["'];?\s*$/gmu, "");
  return withoutExports.trim().length === 0;
}

describe("hosted lane layout", () => {
  test("deletes the old parallel hosted source families", () => {
    expect(existsSync(gatewayPath("host"))).toBeFalse();
    expect(existsSync(gatewayPath("session"))).toBeFalse();
    expect(existsSync(gatewayPath("runtime-plugins"))).toBeFalse();
  });

  test("keeps the hosted lane narrow at the top level", () => {
    expect(topLevelFiles("hosted")).toEqual([
      "api.ts",
      "compaction.ts",
      "context.ts",
      "provider.ts",
      "session.ts",
      "thread-loop.ts",
    ]);
    expect(topLevelDirectories("hosted")).toEqual(["internal"]);
    expect(topLevelDirectories("hosted", "internal")).toEqual([
      "compaction",
      "context",
      "provider",
      "session",
      "shared",
      "thread-loop",
    ]);
    expect(topLevelFiles("extensions")).toEqual(["api.ts"]);
  });

  test("bans family-slicing filenames at hosted top level", () => {
    const banned =
      /(?:^|\/)[^/]+-(?:types|profiles|policy|wiring|ports|decision-resolver)\.ts$|(?:^|\/)pipeline\.ts$/u;
    const offenders = listGatewayProductionFiles()
      .filter((file) => file.startsWith("packages/brewva-gateway/src/hosted/"))
      .filter((file) => !file.includes("/internal/"))
      .filter((file) => banned.test(file));
    expect(offenders).toEqual([]);
  });

  test("does not recreate the deleted hosted families under hosted/internal", () => {
    const bannedPaths = listGatewayProductionFiles()
      .filter((file) => file.startsWith("packages/brewva-gateway/src/hosted/internal/"))
      .filter((file) =>
        /^packages\/brewva-gateway\/src\/hosted\/internal\/behavior(?:\/|$)/u.test(file),
      )
      .concat(
        listGatewayProductionFiles().filter((file) =>
          [
            "packages/brewva-gateway/src/hosted/internal/thread-loop/context/api.ts",
            "packages/brewva-gateway/src/hosted/internal/thread-loop/evidence/api.ts",
            "packages/brewva-gateway/src/hosted/internal/thread-loop/lifecycle/api.ts",
            "packages/brewva-gateway/src/hosted/internal/session/tools/api.ts",
            "packages/brewva-gateway/src/hosted/internal/provider/api.ts",
            "packages/brewva-gateway/src/hosted/internal/provider/request-api.ts",
            "packages/brewva-gateway/src/hosted/internal/session/api.ts",
            "packages/brewva-gateway/src/hosted/internal/session/ports.ts",
            "packages/brewva-gateway/src/hosted/internal/session/types.ts",
            "packages/brewva-gateway/src/hosted/internal/session/wiring.ts",
            "packages/brewva-gateway/src/hosted/internal/session/hosted-session-backend.ts",
            "packages/brewva-gateway/src/hosted/internal/session/hosted-session-backend-contract.ts",
            "packages/brewva-gateway/src/hosted/internal/session/hosted-session-backend-local.ts",
            "packages/brewva-gateway/src/hosted/internal/session/hosted-session-bootstrap.ts",
            "packages/brewva-gateway/src/hosted/internal/session/ports.ts",
            "packages/brewva-gateway/src/hosted/internal/session/wiring.ts",
            "packages/brewva-gateway/src/hosted/internal/session/init/wiring.ts",
            "packages/brewva-gateway/src/hosted/internal/thread-loop/ports.ts",
            "packages/brewva-gateway/src/hosted/internal/thread-loop/api.ts",
            "packages/brewva-gateway/src/hosted/internal/thread-loop/contracts.ts",
            "packages/brewva-gateway/src/hosted/internal/thread-loop/worker-main.ts",
            "packages/brewva-gateway/src/hosted/internal/thread-loop/prompt-recovery-state.ts",
            "packages/brewva-gateway/src/hosted/internal/thread-loop/tool-attempt-binding.ts",
            "packages/brewva-gateway/src/hosted/internal/thread-loop/compaction-generation-coordinator.ts",
            "packages/brewva-gateway/src/hosted/internal/thread-loop/thread-loop-decision-resolver.ts",
            "packages/brewva-gateway/src/hosted/internal/thread-loop/thread-loop-profiles.ts",
            "packages/brewva-gateway/src/hosted/internal/thread-loop/thread-loop-types.ts",
            "packages/brewva-gateway/src/hosted/internal/thread-loop/types.ts",
            "packages/brewva-gateway/src/hosted/internal/thread-loop/wiring.ts",
          ].includes(file),
        ),
      )
      .toSorted();
    expect(bannedPaths).toEqual([]);
  });

  test("does not keep shallow pass-through files in hosted owner internals", () => {
    const allowedProtocolSeams = new Set([
      "packages/brewva-gateway/src/hosted/internal/thread-loop/worker/api.ts",
    ]);
    const offenders = listGatewayProductionFiles()
      .filter((file) =>
        /^packages\/brewva-gateway\/src\/hosted\/internal\/(?:session|thread-loop)\//u.test(file),
      )
      .filter((file) => !allowedProtocolSeams.has(file))
      .filter((file) => readRepoFile(file).split("\n").length < 80)
      .filter((file) => isPassThroughReExport(readRepoFile(file)))
      .toSorted();
    expect(offenders).toEqual([]);
  });

  test("does not recreate nested internal folders or create-session aliases", () => {
    const offenders = listGatewayProductionFiles().filter(
      (file) =>
        file.startsWith("packages/brewva-gateway/src/hosted/") &&
        (file.includes("/internal/internal/") || file.endsWith("/create-session.ts")),
    );
    expect(offenders).toEqual([]);
  });

  test("keeps managed agent session below the host-first hotspot budget", () => {
    const source = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/session/managed-agent/session.ts",
    );
    expect(source.split("\n").length).toBeLessThanOrEqual(1_568);
  });

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
      "installSessionCompactionRecovery",
    ]) {
      expect(publicFacade).not.toContain(privateExport);
    }
  });

  test("does not contain corrupted package-relative import specifiers", () => {
    const corruptedImportPrefix = ["@brewva", "../../../"].join("");
    const offenders = listRepoTypeScriptFiles("packages", "test", "script").filter((file) =>
      readRepoFile(file).includes(corruptedImportPrefix),
    );
    expect(offenders).toEqual([]);
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

  test("routes context materialization side effects through the hosted materialization owner", () => {
    const materializationPath =
      "packages/brewva-gateway/src/hosted/internal/context/materialization.ts";
    const materialization = readRepoFile(materializationPath);
    expect(materialization).toContain("planHostedContextMaterialization");
    expect(materialization).toContain("commitHostedContextMaterialization");
    expect(materialization).toContain("HOSTED_CONTEXT_MATERIALIZATION_EFFECT_ORDER");
    expect(materialization).not.toMatch(/effects\.push\("[a-z_]+"/u);
    for (const expectedEffect of [
      "usage_observed",
      "compaction_nudge_rendered",
      "prompt_stability_observed",
      "provider_cache_observed",
      "visible_read_state_remembered",
      "capability_disclosure_rendered",
      "workbench_context_rendered",
      "delegation_outcome_surfaced",
      "telemetry_emitted",
    ]) {
      expect(materialization).toContain(expectedEffect);
    }

    const offenders = listGatewayProductionFiles()
      .filter((file) => file.startsWith("packages/brewva-gateway/src/hosted/"))
      .filter((file) => file !== materializationPath)
      .filter((file) => {
        const source = readRepoFile(file);
        return (
          source.includes(".operator.context.providerCache.observe(") ||
          source.includes(".operator.context.visibleRead.rememberState(")
        );
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
      "packages/brewva-gateway/src/hosted/internal/thread-loop/",
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
