import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

const RUNTIME_TURN = "packages/brewva-runtime/src/runtime/turn";
const TURN_CHAIN = "packages/brewva-gateway/src/hosted/internal/turn";
const EDGE = "packages/brewva-gateway/src/hosted/edge";
const SESSION_WATCHDOG = "packages/brewva-gateway/src/hosted/internal/session/watchdog";

function listTypeScriptFiles(relativeDir: string): string[] {
  const absoluteDir = resolve(repoRoot, relativeDir);
  const files: string[] = [];

  for (const entry of readdirSync(absoluteDir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".tmp") {
      continue;
    }
    const absolutePath = resolve(absoluteDir, entry);
    const relativePath = `${relativeDir}/${entry}`;
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      files.push(...listTypeScriptFiles(relativePath));
      continue;
    }
    if (stats.isFile() && relativePath.endsWith(".ts")) {
      files.push(relativePath);
    }
  }

  return files;
}

function read(file: string): string {
  return readFileSync(resolve(repoRoot, file), "utf-8");
}

describe("turn two-layer boundary (RFC turn-adapter split)", () => {
  test("runtime/turn imports no gateway code (kernel purity)", () => {
    const offenders = listTypeScriptFiles(RUNTIME_TURN)
      .filter((file) => /@brewva\/brewva-gateway/u.test(read(file)))
      .toSorted();

    expect(offenders).toEqual([]);
  });

  test("worker message protocol is confined to edge, absent from the turn chain", () => {
    const protocolPattern = /ParentToWorkerMessage|WorkerToParentMessage/u;

    const turnOffenders = listTypeScriptFiles(TURN_CHAIN)
      .filter((file) => protocolPattern.test(read(file)))
      .toSorted();

    expect(turnOffenders).toEqual([]);

    // Non-vacuous: the protocol must actually live in edge, otherwise the
    // absence above would guard nothing. The worker boundary defines it.
    const edgeHolders = listTypeScriptFiles(EDGE).filter((file) =>
      protocolPattern.test(read(file)),
    );

    expect(edgeHolders).toContain(`${EDGE}/worker/protocol.ts`);
  });

  test("turn chain holds no shadow turn loop (no kernel.beginToolCall)", () => {
    const offenders = listTypeScriptFiles(TURN_CHAIN)
      .filter((file) => /beginToolCall/u.test(read(file)))
      .toSorted();

    expect(offenders).toEqual([]);
  });

  test("turn chain does not import the edge layer", () => {
    const edgeImportPattern = /from\s+"[^"]*\/edge\//u;

    const offenders = listTypeScriptFiles(TURN_CHAIN)
      .filter((file) => edgeImportPattern.test(read(file)))
      .toSorted();

    expect(offenders).toEqual([]);
  });

  test("edge owns worker mechanics while session orchestration owns task-stall policy", () => {
    expect(existsSync(resolve(repoRoot, `${EDGE}/watchdog`))).toBe(false);
    expect(existsSync(resolve(repoRoot, `${SESSION_WATCHDOG}/task-progress-watchdog.ts`))).toBe(
      true,
    );
    expect(existsSync(resolve(repoRoot, `${SESSION_WATCHDOG}/task-stall-adjudication.ts`))).toBe(
      true,
    );
  });

  test("turn consumes a checked runtime-provider face instead of optional session methods", () => {
    const contract = read(`${TURN_CHAIN}/runtime-turn-session.ts`);
    const harness = read(`${TURN_CHAIN}/runtime-turn-harness-execution-ports.ts`);
    const provider = read(`${TURN_CHAIN}/runtime-turn-provider.ts`);
    const verificationGates = read(`${TURN_CHAIN}/runtime-turn-verification-gates.ts`);
    const face = read(
      "packages/brewva-gateway/src/hosted/internal/session/managed-agent/runtime-provider-face.ts",
    );
    const session = read(
      "packages/brewva-gateway/src/hosted/internal/session/managed-agent/session.ts",
    );

    expect(contract).toContain("getRuntimeProviderFace(): RuntimeProviderFace;");
    expect(contract).not.toMatch(/getRuntimeVerificationGateManifests\?\(/u);
    expect(contract).toMatch(
      /extends Pick<\s*BrewvaModelCatalog,\s*"getAll" \| "getApiKeyAndHeaders"\s*>/u,
    );
    expect(contract).not.toContain("getAll?():");
    expect(face).toContain("implements RuntimeProviderFace");
    expect(session).toContain("getRuntimeProviderFace(): RuntimeProviderFace");
    expect(harness).toContain("const providerFace = resolveRuntimeProviderFace(session);");
    expect(harness).toContain("createHostedRuntimeProviderPort(session, providerFace)");
    expect(provider).not.toContain("resolveRuntimeProviderFace");
    expect(provider).not.toMatch(/getAll\?\./u);
    expect(verificationGates).not.toContain("RuntimeVerificationGateSource | null");

    const obsoleteForwarders = [
      "getRuntimeModelCatalog",
      "getRuntimeActiveModelRole",
      "getRuntimeProviderCachePolicy",
      "getRuntimeProviderTransport",
      "getRuntimeVerificationGateManifests",
      "getRuntimeVerificationGateEvidence",
      "getRuntimeModelRoutingSettings",
      "recordRuntimeProviderCredentialRotated",
      "prepareRuntimeProviderPayload",
      "observeRuntimeCacheRender",
      "observeRuntimeAssistantMessage",
    ];
    for (const method of obsoleteForwarders) {
      expect(session).not.toMatch(new RegExp(`\\n  (?:async )?${method}\\(`, "u"));
    }
  });

  test("tool ports do not require provider capabilities", () => {
    const authority = read(`${TURN_CHAIN}/runtime-turn-authority.ts`);
    const executor = read(`${TURN_CHAIN}/runtime-turn-tool-executor.ts`);

    expect(authority).toContain("isRuntimeToolSession(session)");
    expect(executor).toContain("isRuntimeToolSession(session)");
    expect(authority).not.toContain("resolveRuntimeProviderFace");
    expect(executor).not.toContain("resolveRuntimeProviderFace");
  });
});
