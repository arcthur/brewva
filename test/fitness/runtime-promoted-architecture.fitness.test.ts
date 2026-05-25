import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function collectSourceFiles(relativePath: string): string[] {
  const root = resolve(repoRoot, relativePath);
  const files: string[] = [];
  if (!existsSync(root)) return files;
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "dist" || entry.name === "node_modules") continue;
        walk(absolutePath);
        continue;
      }
      if (entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name)) {
        files.push(absolutePath);
      }
    }
  }
  walk(root);
  return files.toSorted();
}

function repoPath(absolutePath: string): string {
  return relative(repoRoot, absolutePath).replaceAll("\\", "/");
}

function readInterfaceBlock(source: string, name: string): string {
  const match = new RegExp(`export\\s+interface\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`, "u").exec(
    source,
  );
  if (!match?.[1]) {
    throw new Error(`Missing interface ${name}`);
  }
  return match[1];
}

describe("four-port runtime architecture fitness", () => {
  test("public runtime root exposes only the four-port contract", () => {
    const rootIndex = readRepoFile("packages/brewva-runtime/src/index.ts");
    const publicIndex = readRepoFile("packages/brewva-runtime/src/public/index.ts");
    const runtimeApi = readRepoFile("packages/brewva-runtime/src/runtime/runtime-api.ts");
    const runtime = readInterfaceBlock(runtimeApi, "BrewvaRuntime");

    expect(rootIndex.trim()).toBe('export * from "./public/index.js";');
    expect(publicIndex).not.toMatch(/export \* from /u);
    expect(publicIndex).not.toMatch(
      /BrewvaRuntimeRoot|BrewvaHostedRuntimePort|BrewvaToolRuntimePort|BrewvaOperatorRuntimePort|BrewvaRuntimeInstance|selectOperatorRuntimePort/u,
    );
    expect(runtime).toContain("readonly tape: TapePort;");
    expect(runtime).toContain("readonly kernel: KernelPort;");
    expect(runtime).toContain("readonly model: ModelPort;");
    expect(runtime).toContain("turn(input: TurnInput): AsyncIterable<TurnFrame>;");
    expect(runtime).not.toMatch(/\bauthority\b|\binspect\b|\bhosted\b|\boperator\b|\btool\b/u);

    const publicRuntimeImplementation = readRepoFile(
      "packages/brewva-runtime/src/runtime/runtime.ts",
    );
    expect(publicRuntimeImplementation).not.toContain("runtime-facade-state");
    expect(publicRuntimeImplementation).not.toContain("createInternalRuntimeController");
    expect(publicRuntimeImplementation).not.toContain("Symbol.for");
    expect(publicRuntimeImplementation).not.toContain("getRuntimeTapeCommitForInternalUse");
    expect(publicRuntimeImplementation).not.toContain("getRuntimeTapeSessionIdsForInternalUse");
  });

  test("four-port runtime API file does not import the legacy semantic surface lattice", () => {
    const runtimeApi = readRepoFile("packages/brewva-runtime/src/runtime/runtime-api.ts");
    const kernelPortSource = readRepoFile("packages/brewva-runtime/src/runtime/kernel/port.ts");
    const kernel = readInterfaceBlock(kernelPortSource, "KernelPort");
    const customPayload = readInterfaceBlock(
      readRepoFile("packages/brewva-runtime/src/runtime/tape/events.ts"),
      "CustomEventPayload",
    );

    expect(runtimeApi).not.toMatch(
      /RuntimeOps|BrewvaRuntimeExtensions|BrewvaToolRuntimeExtensions/u,
    );
    expect(runtimeApi).not.toMatch(/GovernancePort|governancePort/u);
    expect(runtimeApi).not.toMatch(
      /interface BrewvaRuntimeRoot|interface BrewvaRuntimeInstance|interface BrewvaHostedRuntimePort|interface BrewvaToolRuntimePort|interface BrewvaOperatorRuntimePort/u,
    );
    expect(kernel).not.toContain("requestApproval");
    expect(customPayload).toContain('readonly authority: "none" | "advisory";');
    expect(runtimeApi).not.toContain("selectSkills(");
    expect(runtimeApi).not.toContain("maxConcurrentTools");
    expect(runtimeApi).not.toMatch(/readonly event\?: CanonicalEvent/u);
    expect(runtimeApi).not.toMatch(/interface CanonicalEvent<|CanonicalEvent<|payload\?: unknown/u);
    expect(runtimeApi).not.toContain("content: unknown");
    expect(runtimeApi).toContain('CanonicalEventBase<"tool.committed", ToolCommittedPayload>');
    expect(kernelPortSource).toContain(
      "export type ToolExecutionResultContent = string | readonly PromptContentPart[] | JsonValue;",
    );
  });

  test("production adapter code does not reuse removed public runtime port names", () => {
    const removedPortNames = [
      "BrewvaRuntimeRoot",
      "BrewvaHostedRuntimePort",
      "BrewvaToolRuntimePort",
      "BrewvaOperatorRuntimePort",
      "HostedRuntimeAdapterBundle",
      "OperatorRuntimeAdapterPort",
      "RuntimeOperatorPort",
    ];
    const offenders = collectSourceFiles("packages")
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return removedPortNames.some((name) => source.includes(name));
      })
      .map(repoPath)
      .toSorted();

    expect(offenders).toEqual([]);
  });

  test("canonical event and recovery vocabularies remain compressed", () => {
    const runtimeApi = readRepoFile("packages/brewva-runtime/src/runtime/runtime-api.ts");
    const canonicalEventItems =
      runtimeApi
        .match(/export const CANONICAL_EVENT_TYPES = \[([\s\S]*?)\] as const;/u)?.[1]
        ?.match(/"[^"]+"/gu) ?? [];
    const recoveryCauseItems =
      runtimeApi
        .match(/export const RUNTIME_RECOVERY_CAUSES = \[([\s\S]*?)\] as const;/u)?.[1]
        ?.match(/"[^"]+"/gu) ?? [];

    expect(canonicalEventItems).toHaveLength(14);
    expect(recoveryCauseItems).toEqual([
      '"approval_pending"',
      '"compaction_required"',
      '"provider_retry"',
      '"interrupt"',
      '"terminal_commit"',
    ]);
  });

  test("canonical tape storage is the only configured event JSONL plane", () => {
    const runtime = readRepoFile("packages/brewva-runtime/src/runtime/runtime.ts");
    const defaults = readRepoFile("packages/brewva-runtime/src/config/defaults.ts");
    const configTypes = readRepoFile("packages/brewva-runtime/src/config/types.ts");
    const normalizeInfrastructure = readRepoFile(
      "packages/brewva-runtime/src/config/normalize-infrastructure.ts",
    );

    expect(defaults).toContain('dir: ".brewva/tape"');
    expect(defaults).not.toContain('dir: ".orchestrator/events"');
    expect(configTypes).not.toContain("events: {\n      enabled: boolean;\n      dir: string;");
    expect(normalizeInfrastructure).not.toContain("infrastructureEventsInput.dir");
    expect(runtime).toContain("tapeDir: configState.config.tape.dir");
    expect(runtime).toContain("runtimePhysicsUsesDurableTape(physics)");
    expect(runtime).not.toContain("tapeDir: controller.config.infrastructure.events.dir");
    expect(runtime).not.toContain("enabled: controller.config.infrastructure.events.enabled");
  });

  test("legacy adapter event writes are removed from the runtime event plane", () => {
    expect(
      existsSync(
        resolve(repoRoot, "packages/brewva-runtime/src/runtime/runtime-internal-assembly.ts"),
      ),
    ).toBe(false);
    expect(
      existsSync(resolve(repoRoot, "packages/brewva-runtime/src/internal/runtime-state.ts")),
    ).toBe(false);
    const writeOffenders = collectSourceFiles("packages")
      .filter((file) =>
        /\.events\.append\(\{|eventStore\.append\(/u.test(readFileSync(file, "utf8")),
      )
      .map(repoPath)
      .toSorted();

    expect(writeOffenders).toEqual([]);
  });

  test("legacy event record store and JSONL registry are deleted", () => {
    const removedFiles = [
      "packages/brewva-runtime/src/internal/legacy-runtime/tape/event-ops/event-record-store.ts",
      "packages/brewva-runtime/src/internal/legacy-runtime/tape/event-ops/port-adapter.ts",
      "packages/brewva-runtime/src/events/store.ts",
      "packages/brewva-runtime/src/events/registry.ts",
      "packages/brewva-runtime/src/events/types.ts",
    ];

    for (const file of removedFiles) {
      expect(existsSync(resolve(repoRoot, file)), file).toBe(false);
    }
  });

  test("global legacy event registry is deleted", () => {
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/events/registry.ts"))).toBe(
      false,
    );
  });

  test("channel control-plane and daemon production code do not use the generic event write plane", () => {
    const guardedRoots = [
      "packages/brewva-gateway/src/channels",
      "packages/brewva-gateway/src/daemon",
    ];
    const guardedFiles = guardedRoots
      .flatMap((root) => collectSourceFiles(root))
      .concat([resolve(repoRoot, "packages/brewva-cli/src/commands/noninteractive/daemon.ts")]);
    const offenders = guardedFiles
      .filter((file) =>
        /ops\.events\.records\.record|events\.records\.record|ops\.channel\.recovery\.record/u.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map(repoPath)
      .toSorted();
    const controlPlaneEventWriteOffenders = collectSourceFiles(
      "packages/brewva-runtime/src/control-plane",
    )
      .filter((file) => /recordEvent\(|recordEvent:/u.test(readFileSync(file, "utf8")))
      .map(repoPath)
      .toSorted();

    expect(offenders).toEqual([]);
    expect(controlPlaneEventWriteOffenders).toEqual([]);
  });

  test("production code does not use generic event records or removed read-model writer names", () => {
    const offenders = collectSourceFiles("packages")
      .filter((file) => {
        const path = repoPath(file);
        if (
          path ===
          "packages/brewva-runtime/src/internal/legacy-runtime/tape/event-ops/port-adapter.ts"
        ) {
          return false;
        }
        return /ops\.events\.records\.record|events\.records\.record|events\.compatibility|recordReadModelEvent/u.test(
          readFileSync(file, "utf8"),
        );
      })
      .map(repoPath)
      .toSorted();

    expect(offenders).toEqual([]);
  });

  test("runtime kernel/tape internals do not expose legacy writer class names", () => {
    const offenders = collectSourceFiles("packages")
      .filter((file) =>
        /\bToolGateService\b|\bToolInvocationSpine\b|\bLedgerService\b|\bEvidenceLedger\b|\bledgerService\b|\bevidenceLedger\b/u.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map(repoPath)
      .toSorted();

    expect(offenders).toEqual([]);
  });

  test("session index and recall do not consume old JSONL event logs", () => {
    const guardedFiles = [
      ...collectSourceFiles("packages/brewva-session-index/src"),
      ...collectSourceFiles("packages/brewva-recall/src"),
    ];
    const offenders = guardedFiles
      .filter((file) =>
        /log-reader\/jsonl|readEventsFromLog|ParsedLogEvent|events\.log\.listSessionIds|events\.log\.getPath/u.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map(repoPath)
      .toSorted();

    expect(offenders).toEqual([]);
  });

  test("runtime package exports semantic subpaths and no compat subpaths", () => {
    const packageJson = JSON.parse(readRepoFile("packages/brewva-runtime/package.json")) as {
      exports?: Record<string, unknown>;
    };
    const exportKeys = Object.keys(packageJson.exports ?? {});
    expect(exportKeys).not.toContain("./protocol");
    expect(exportKeys).not.toContain("./governance");
    expect(exportKeys).not.toContain("./context");
    expect(exportKeys).not.toContain("./recovery");
    expect(exportKeys).not.toContain("./runtime-assembly");
    expect(exportKeys).not.toContain("./internal/runtime-assembly");
    expect(exportKeys).not.toContain("./events");
    expect(exportKeys.some((key) => key.startsWith("./compat"))).toBe(false);
    expect(Object.keys(packageJson.exports ?? {})).not.toContain("./legacy-runtime");
    expect(Object.keys(packageJson.exports ?? {})).not.toContain("./internal/legacy-runtime");
    expect(Object.keys(packageJson.exports ?? {})).not.toContain("./internal/events");
    expect(Object.keys(packageJson.exports ?? {})).not.toContain("./internal/contracts");
    expect(Object.keys(packageJson.exports ?? {})).not.toContain("./internal/governance");

    const offenders = collectSourceFiles("packages")
      .filter((file) =>
        /@brewva\/brewva-runtime\/(?:protocol|events|compat\/|legacy-runtime|internal\/events|internal\/contracts|internal\/governance)(?:["'])/u.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map(repoPath)
      .toSorted();

    expect(offenders).toEqual([]);
  });

  test("runtime protocol module remains deleted instead of restoring a contracts kitchen sink", () => {
    const packageJson = JSON.parse(readRepoFile("packages/brewva-runtime/package.json")) as {
      exports?: Record<string, unknown>;
    };

    expect(Object.keys(packageJson.exports ?? {})).not.toContain("./protocol");
    expect(Object.keys(packageJson.exports ?? {})).not.toContain("./contracts");
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/protocol.ts"))).toBe(false);
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/protocol"))).toBe(false);
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/protocol/types"))).toBe(false);
  });

  test("four-port runtime path does not import read-model implementation modules", () => {
    const fourPortFiles = [
      "packages/brewva-runtime/src/public/index.ts",
      "packages/brewva-runtime/src/runtime/runtime.ts",
      "packages/brewva-runtime/src/runtime/runtime-api.ts",
      "packages/brewva-runtime/src/runtime/tape/impl.ts",
      "packages/brewva-runtime/src/runtime/kernel/impl.ts",
      "packages/brewva-runtime/src/runtime/model/impl.ts",
      "packages/brewva-runtime/src/runtime/turn/impl.ts",
    ];
    const offenders = fourPortFiles.filter((file) => /read-models\//u.test(readRepoFile(file)));

    expect(offenders).toEqual([]);
  });

  test("four-port kernel owns action policy admission before tool execution", () => {
    const kernel = readRepoFile("packages/brewva-runtime/src/runtime/kernel/impl.ts");
    const turnRunner = readRepoFile("packages/brewva-runtime/src/runtime/turn/impl.ts");
    const hostedExecutionPorts = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-execution-ports.ts",
    );
    const hostedAuthority = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-authority.ts",
    );
    const hostedRuntimeTurn = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/session/runtime-turn-runtime.ts",
    );

    expect(kernel).toContain('./policy/public-contract.js"');
    expect(kernel).toContain("resolveToolAuthority");
    expect(kernel).toContain("createActionPolicyRegistry");
    expect(kernel).toContain('admission.admission === "deny"');
    expect(kernel).toContain("approvalRequestFor(call, admission)");
    expect(turnRunner).toContain("input.kernel.beginToolCall");
    expect(turnRunner).not.toMatch(/resolveToolAuthority|createActionPolicyRegistry/u);
    expect(hostedExecutionPorts).toContain("createHostedRuntimeToolAuthorityResolver");
    expect(hostedAuthority).toContain("getBrewvaToolMetadata");
    expect(hostedAuthority).toContain('base.source === "exact"');
    expect(hostedRuntimeTurn).toContain("resolveToolAuthority");
    expect(hostedRuntimeTurn).toContain("createRuntime?.({ physics })");
  });

  test("kernel policy primitives live in the four-port kernel, not legacy governance", () => {
    const oldPolicyFiles = [
      "packages/brewva-runtime/src/internal/legacy-runtime/kernel/governance/action-policy.ts",
      "packages/brewva-runtime/src/internal/legacy-runtime/kernel/governance/contracts.ts",
      "packages/brewva-runtime/src/internal/legacy-runtime/kernel/governance/commitment-posture.ts",
      "packages/brewva-runtime/src/internal/legacy-runtime/kernel/governance/tool-governance.ts",
    ];
    const newPolicyFiles = [
      "packages/brewva-runtime/src/runtime/kernel/policy/tool-admission-policy.ts",
      "packages/brewva-runtime/src/runtime/kernel/policy/policy-types.ts",
      "packages/brewva-runtime/src/runtime/kernel/policy/effect-posture.ts",
      "packages/brewva-runtime/src/runtime/kernel/policy/tool-decision.ts",
      "packages/brewva-runtime/src/runtime/kernel/policy/public-contract.ts",
    ];

    for (const file of oldPolicyFiles) {
      expect(existsSync(resolve(repoRoot, file)), file).toBe(false);
    }
    for (const file of newPolicyFiles) {
      expect(existsSync(resolve(repoRoot, file)), file).toBe(true);
    }
    expect(
      existsSync(resolve(repoRoot, "packages/brewva-runtime/src/runtime/kernel/authority")),
    ).toBe(false);
  });

  test("repo-owned callers do not import removed compat subpaths", () => {
    const offenders = collectSourceFiles("packages")
      .concat(collectSourceFiles("test"))
      .filter((file) => /@brewva\/brewva-runtime\/compat\//u.test(readFileSync(file, "utf8")))
      .map(repoPath)
      .toSorted();

    expect(offenders).toEqual([]);
  });

  test("runtime assembly no longer exports compatibility runtime instances", () => {
    const runtimeFiles = collectSourceFiles("packages/brewva-runtime/src/runtime").map(repoPath);
    const runtimeImplementation = readRepoFile("packages/brewva-runtime/src/runtime/runtime.ts");

    expect(runtimeFiles).not.toContain("packages/brewva-runtime/src/runtime/legacy-runtime-api.ts");
    expect(runtimeFiles).not.toContain(
      "packages/brewva-runtime/src/runtime/runtime-compat-state.ts",
    );
    expect(runtimeFiles).not.toContain("packages/brewva-runtime/src/runtime/runtime-compat-ops.ts");
    expect(
      existsSync(resolve(repoRoot, "packages/brewva-runtime/src/internal/runtime-state.ts")),
    ).toBe(false);
    expect(
      existsSync(resolve(repoRoot, "packages/brewva-runtime/src/internal/runtime-ops.ts")),
    ).toBe(false);
    expect(
      existsSync(resolve(repoRoot, "packages/brewva-runtime/src/internal/runtime-assembly.ts")),
    ).toBe(false);
    expect(runtimeImplementation).not.toContain("readonly instance:");
    expect(runtimeImplementation).not.toContain("createLegacyRuntimeInstanceFromController");
    expect(runtimeImplementation).not.toContain("selectOperatorRuntimePort");
  });

  test("gateway hosted runtime adapter is a single ops view, not a root hosted tool operator bundle", () => {
    const adapter = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/session/runtime-ports.ts",
    );
    const hostedApi = readRepoFile("packages/brewva-gateway/src/hosted/api.ts");

    expect(adapter).toContain("): HostedRuntimeAdapterPort");
    expect(adapter).toContain("readonly ops: RuntimeAdapterOpsPort;");
    expect(adapter).not.toMatch(
      /HostedRuntimeAdapterBundle|OperatorRuntimeAdapterPort|RuntimeOperatorPort|readonly root:|readonly hosted:|readonly operator:/u,
    );
    expect(hostedApi).not.toMatch(
      /HostedRuntimeAdapterBundle|OperatorRuntimeAdapterPort|RuntimeOperatorPort/u,
    );
  });

  test("internal runtime assembly package subpath is removed", () => {
    const offenders = collectSourceFiles("packages")
      .filter((file) =>
        readFileSync(file, "utf8").includes("@brewva/brewva-runtime/internal/runtime-assembly"),
      )
      .map(repoPath)
      .toSorted();

    expect(offenders).toEqual([]);
  });

  test("legacy runtime internal subpath is removed from production code", () => {
    const offenders = collectSourceFiles("packages")
      .filter((file) => readFileSync(file, "utf8").includes("../helpers/runtime.js"))
      .map(repoPath)
      .toSorted();

    expect(offenders).toEqual([]);
  });

  test("new runtime implementation lives under tape kernel model and turn", () => {
    const runtimeFiles = collectSourceFiles("packages/brewva-runtime/src/runtime");
    const required = [
      "packages/brewva-runtime/src/runtime/tape/impl.ts",
      "packages/brewva-runtime/src/runtime/kernel/impl.ts",
      "packages/brewva-runtime/src/runtime/model/impl.ts",
      "packages/brewva-runtime/src/runtime/turn/impl.ts",
    ];

    for (const file of required) {
      expect(runtimeFiles.map(repoPath)).toContain(file);
    }

    const removedLegacyRuntimeDirectories = [
      "packages/brewva-runtime/src/runtime/engine",
      "packages/brewva-runtime/src/runtime/engine/lifecycle",
      "packages/brewva-runtime/src/runtime/engine/parallel",
      "packages/brewva-runtime/src/runtime/engine/recovery",
      "packages/brewva-runtime/src/runtime/engine/sessions",
      "packages/brewva-runtime/src/runtime/kernel/governance",
      "packages/brewva-runtime/src/runtime/kernel/patching",
      "packages/brewva-runtime/src/runtime/kernel/proposals",
      "packages/brewva-runtime/src/runtime/kernel/tools",
      "packages/brewva-runtime/src/runtime/kernel/verification",
      "packages/brewva-runtime/src/runtime/model/context",
      "packages/brewva-runtime/src/runtime/model/reasoning",
      "packages/brewva-runtime/src/runtime/model/skills",
      "packages/brewva-runtime/src/runtime/tape/event-ops",
    ];
    for (const directory of removedLegacyRuntimeDirectories) {
      expect(existsSync(resolve(repoRoot, directory)), directory).toBe(false);
    }
    expect(
      existsSync(resolve(repoRoot, "packages/brewva-runtime/src/internal/legacy-runtime")),
    ).toBe(false);
  });

  test("runtime domain lattice does not regain rehomed control-plane and infrastructure folders", () => {
    const domainRoot = resolve(repoRoot, "packages/brewva-runtime/src/domain");
    const rootTapeViews = resolve(repoRoot, "packages/brewva-runtime/src/tape-views");
    expect(existsSync(domainRoot)).toBe(false);
    expect(existsSync(rootTapeViews)).toBe(false);
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/read-models"))).toBe(false);
  });

  test("legacy tape views and read models are not rehomed as compatibility internals", () => {
    const runtimeSourceFiles = collectSourceFiles("packages/brewva-runtime/src")
      .map(repoPath)
      .toSorted();

    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/compat"))).toBe(false);
    expect(
      runtimeSourceFiles.some((file) => file.startsWith("packages/brewva-runtime/src/tape-views/")),
    ).toBe(false);
    expect(
      runtimeSourceFiles.some((file) =>
        file.startsWith("packages/brewva-runtime/src/read-models/"),
      ),
    ).toBe(false);
  });

  test("rehomed runtime modules do not keep domain registrar names", () => {
    const rehomedRoots = [
      "packages/brewva-runtime/src/control-plane",
      "packages/brewva-runtime/src/model/workbench",
      "packages/brewva-runtime/src/runtime",
      "packages/brewva-runtime/src/read-models",
    ];
    const offenders = rehomedRoots
      .flatMap((root) => collectSourceFiles(root))
      .filter((file) =>
        /register[A-Za-z]+Domain|Runtime[A-Za-z]+DomainRegistration/u.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map(repoPath)
      .toSorted();

    expect(offenders).toEqual([]);
  });

  test("runtime assembly surfaces use ops/write/read/control terminology instead of authority inspect operator", () => {
    const surfaceRoots = [
      "packages/brewva-runtime/src/control-plane",
      "packages/brewva-runtime/src/model/workbench",
      "packages/brewva-runtime/src/runtime",
      "packages/brewva-runtime/src/read-models",
    ];
    const offenders = surfaceRoots
      .flatMap((root) => collectSourceFiles(root))
      .filter((file) => /(?:Authority|Inspect|Operator)Surface/u.test(readFileSync(file, "utf8")))
      .map(repoPath)
      .toSorted();

    expect(offenders).toEqual([]);
    expect(
      existsSync(resolve(repoRoot, "packages/brewva-runtime/src/internal/runtime-ops.ts")),
    ).toBe(false);
  });

  test("rehomed runtime modules do not keep domain seven-piece filenames", () => {
    const rehomedRoots = [
      "packages/brewva-runtime/src/channels",
      "packages/brewva-runtime/src/control-plane",
      "packages/brewva-runtime/src/credentials",
      "packages/brewva-runtime/src/delegation",
      "packages/brewva-runtime/src/model/workbench",
      "packages/brewva-runtime/src/runtime",
      "packages/brewva-runtime/src/read-models",
    ];
    const forbiddenBaseNames = new Set([
      "api.ts",
      "events.ts",
      "event-descriptors.ts",
      "registrar.ts",
      "runtime-surface.ts",
      "service.ts",
      "types.ts",
    ]);
    const allowedPortEventFiles = new Set([
      "packages/brewva-runtime/src/runtime/kernel/events.ts",
      "packages/brewva-runtime/src/runtime/model/events.ts",
      "packages/brewva-runtime/src/runtime/tape/events.ts",
      "packages/brewva-runtime/src/runtime/turn/events.ts",
    ]);
    const offenders = rehomedRoots
      .flatMap((root) => collectSourceFiles(root))
      .filter((file) => forbiddenBaseNames.has(file.split("/").at(-1) ?? ""))
      .filter((file) => !allowedPortEventFiles.has(repoPath(file)))
      .map(repoPath)
      .toSorted();

    expect(offenders).toEqual([]);
  });

  test("gateway hosted adapter does not write canonical tape truth directly", () => {
    const gatewayFiles = collectSourceFiles("packages/brewva-gateway/src/hosted")
      .filter((file) => statSync(file).isFile())
      .filter((file) => !file.endsWith("gateway-runtime-adapter.contract.test.ts"));
    const offenders = gatewayFiles
      .filter((file) =>
        /\.tape\.commit\(|commit\(\{\s*type:\s*"(?:turn|tool|msg|reason|checkpoint|approval|cost|runtime)\./u.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map(repoPath)
      .toSorted();

    expect(offenders).toEqual([]);
  });

  test("gateway hosted production path does not own a substrate turn loop", () => {
    expect(
      existsSync(
        resolve(
          repoRoot,
          "packages/brewva-gateway/src/hosted/internal/turn-adapter/hosted-turn-adapter.ts",
        ),
      ),
    ).toBe(false);

    const offenders = collectSourceFiles("packages/brewva-gateway/src/hosted")
      .filter((file) =>
        /\bcreateBrewvaAgentProtocolController\b|\brunBrewvaAgentProtocol\b|\bBrewvaAgentProtocolConfig\b|\brunHostedThreadLoop\b/u.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map(repoPath)
      .toSorted();

    expect(offenders).toEqual([]);
  });

  test("substrate no longer ships a public turn loop or SDK bypass", () => {
    const removedFiles = [
      "packages/brewva-substrate/src/sdk/index.ts",
      "packages/brewva-substrate/src/sdk/session-services.ts",
      "packages/brewva-substrate/src/agent-protocol/controller.ts",
      "packages/brewva-substrate/src/agent-protocol/loop.ts",
      "packages/brewva-substrate/src/agent-protocol/tool-runner.ts",
      "packages/brewva-substrate/src/agent-protocol/effect-runtime.ts",
    ];
    const packageJson = JSON.parse(readRepoFile("packages/brewva-substrate/package.json")) as {
      exports?: Record<string, unknown>;
    };
    const agentProtocolEntrypoint = readRepoFile(
      "packages/brewva-substrate/src/agent-protocol/index.ts",
    );

    for (const file of removedFiles) {
      expect(existsSync(resolve(repoRoot, file))).toBe(false);
    }
    expect(Object.keys(packageJson.exports ?? {})).not.toContain("./sdk");
    expect(Object.keys(packageJson.exports ?? {})).not.toContain("./turn");
    expect(Object.keys(packageJson.exports ?? {})).toContain("./agent-protocol");
    expect(agentProtocolEntrypoint).not.toMatch(
      /createBrewvaAgentProtocolController|runBrewvaAgentProtocol/u,
    );
  });

  test("gateway hosted tool and skill scoping writes through runtime semantic ops", () => {
    const gatewayScopingFiles = [
      "packages/brewva-gateway/src/hosted/internal/session/host-api-installation.ts",
      "packages/brewva-gateway/src/hosted/internal/session/tools/tool-surface.ts",
      "packages/brewva-gateway/src/hosted/internal/session/tools/capability-selection.ts",
      "packages/brewva-gateway/src/hosted/internal/session/skills/skill-selection.ts",
    ];
    const offenders = gatewayScopingFiles
      .filter((file) =>
        /ops\.events\.records\.record|recordEvent|SKILL_SELECTION_RECORDED_EVENT_TYPE|CAPABILITY_SELECTION_RECORDED_EVENT_TYPE|TOOL_SURFACE_RESOLVED_EVENT_TYPE/u.test(
          readRepoFile(file),
        ),
      )
      .toSorted();
    const runtimeOps = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/session/runtime-ops.ts",
    );
    const skillsOps = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/skills.ts",
    );
    const toolsOps = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/tools.ts",
    );

    expect(offenders).toEqual([]);
    expect(skillsOps).toContain('"skill.selection.recorded"');
    expect(toolsOps).toContain('"tool.capability.selected"');
    expect(toolsOps).toContain('"tool.surface.resolved"');
    expect(runtimeOps).not.toContain("events.readModels.record");
    expect(runtimeOps).not.toContain("ops.events.records.record");
  });

  test("production runtime ops writes stay quarantined behind semantic adapters", () => {
    const allowed = new Set([
      "packages/brewva-cli/src/runtime/runtime-ports.ts",
      "packages/brewva-gateway/src/hosted/internal/session/projection/runtime-write-adapters.ts",
      "packages/brewva-gateway/src/hosted/internal/session/runtime-ports.ts",
    ]);
    const writePattern =
      /runtime\.ops\.[a-zA-Z0-9_.]+\.(?:record|commit)|\.ops\.(?:skills\.selection\.record|tools\.surface\.recordResolved|tools\.capabilitySelection\.record|schedule\.events\.record)/u;
    const offenders = [
      ...collectSourceFiles("packages/brewva-cli/src"),
      ...collectSourceFiles("packages/brewva-gateway/src"),
    ]
      .filter((file) => !allowed.has(repoPath(file)))
      .filter((file) => writePattern.test(readFileSync(file, "utf8")))
      .map(repoPath)
      .toSorted();

    expect(offenders).toEqual([]);
  });

  test("gateway production callers do not spread legacy authority or inspect access", () => {
    const offenders = collectSourceFiles("packages/brewva-gateway/src")
      .filter((file) => /\bruntime\.(?:authority|inspect)\b/u.test(readFileSync(file, "utf8")))
      .map(repoPath)
      .toSorted();

    expect(offenders).toEqual([]);
  });

  test("cli production callers do not spread legacy authority or inspect access", () => {
    const offenders = collectSourceFiles("packages/brewva-cli/src")
      .filter((file) => /\bruntime\.(?:authority|inspect)\b/u.test(readFileSync(file, "utf8")))
      .map(repoPath)
      .toSorted();

    expect(offenders).toEqual([]);
  });

  test("tools production callers do not spread legacy authority or inspect access", () => {
    const offenders = collectSourceFiles("packages/brewva-tools/src")
      .filter((file) => /\bruntime\.(?:authority|inspect)\b/u.test(readFileSync(file, "utf8")))
      .map(repoPath)
      .toSorted();

    expect(offenders).toEqual([]);
  });

  test("managed tool capability paths only target capabilities or explicit tool extensions", () => {
    const offenders = collectSourceFiles("packages/brewva-tools/src")
      .filter((file) => /["'](?:authority|inspect|ops)\./u.test(readFileSync(file, "utf8")))
      .map(repoPath)
      .toSorted();

    expect(offenders).toEqual([]);
  });
});
