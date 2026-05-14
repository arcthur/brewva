#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, resolve } from "node:path";

const NODE_VERSION_RANGE = "^20.19.0 || >=22.13.0";

function runOrThrow(
  command: string,
  args: string[],
  options: { cwd: string; input?: string; step: string },
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: "utf8",
  });

  if (result.error) {
    throw new Error(`${options.step} failed to start: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? "";
    const stdout = result.stdout?.trim() ?? "";
    const details = [stderr, stdout].filter((part) => part.length > 0).join("\n");
    throw new Error(
      `${options.step} failed with exit code ${result.status}${details ? `\n${details}` : ""}`,
    );
  }

  return result.stdout ?? "";
}

type Semver = Readonly<{ major: number; minor: number; patch: number }>;

function parseSemver(versionText: string): Semver | null {
  const trimmed = versionText.trim();
  const match = /^v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/u.exec(trimmed);
  if (!match?.groups) return null;

  const major = Number(match.groups.major);
  const minor = Number(match.groups.minor);
  const patch = Number(match.groups.patch);

  if (!Number.isInteger(major) || major < 0) return null;
  if (!Number.isInteger(minor) || minor < 0) return null;
  if (!Number.isInteger(patch) || patch < 0) return null;

  return { major, minor, patch };
}

function isSupportedNodeVersion(version: Semver): boolean {
  if (version.major === 20) return version.minor >= 19;
  if (version.major === 21) return false;
  if (version.major === 22) return version.minor >= 12;
  return version.major > 22;
}

function assertSupportedNodeRuntime(repoRoot: string): void {
  const versionText = runOrThrow("node", ["--version"], {
    cwd: repoRoot,
    step: "node version check",
  });
  const parsed = parseSemver(versionText);
  if (!parsed || !isSupportedNodeVersion(parsed)) {
    throw new Error(
      `node version check failed: detected ${versionText.trim()}, expected Node.js ${NODE_VERSION_RANGE} (ES2023 baseline).`,
    );
  }
}

const DIST_TEXT_EXTENSIONS = new Set([
  ".css",
  ".d.ts",
  ".html",
  ".js",
  ".json",
  ".map",
  ".md",
  ".mjs",
  ".txt",
  ".yaml",
  ".yml",
]);

const DIST_FORBIDDEN_MARKERS = [
  "pi-mono",
  "@mariozechner/pi-coding-agent",
  "@mariozechner/pi-tui",
  "@mariozechner/pi-agent-core",
  '"piConfig"',
];

const DIST_REMOVED_EXEC_MARKERS = [
  "microsandbox",
  "NodeSandbox",
  "MSB_SERVER_URL",
  "sandboxApiKeyRef",
  '"best_available"',
  '"sandbox_required"',
];

const NODE_SAFE_DIST_FORBIDDEN_MARKERS = ["bun:ffi", "@opentui/core"];

function collectTextFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  const pending = [root];
  const files: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const extension = extname(entry.name);
      if (
        DIST_TEXT_EXTENSIONS.has(extension) ||
        entry.name.endsWith(".d.ts") ||
        entry.name.endsWith(".d.ts.map")
      ) {
        files.push(entryPath);
      }
    }
  }
  return files;
}

function assertNoPiEraMarkers(paths: string[]): void {
  assertNoForbiddenMarkers(paths, DIST_FORBIDDEN_MARKERS, "dist artifact branding check failed");
}

function assertNoForbiddenMarkers(
  paths: string[],
  markers: readonly string[],
  label: string,
): void {
  const matches: string[] = [];
  for (const filePath of paths) {
    const content = readFileSync(filePath, "utf8");
    for (const marker of markers) {
      if (content.includes(marker)) {
        matches.push(`${filePath}: ${marker}`);
      }
    }
  }

  if (matches.length > 0) {
    throw new Error(
      `${label}:\n${matches.slice(0, 20).join("\n")}${
        matches.length > 20 ? `\n...and ${matches.length - 20} more` : ""
      }`,
    );
  }
}

function main(): void {
  const repoRoot = process.cwd();
  assertSupportedNodeRuntime(repoRoot);

  const cliDistPath = resolve(repoRoot, "packages/brewva-cli/dist/index.js");
  if (!existsSync(cliDistPath)) {
    throw new Error(`CLI dist entry is missing: ${cliDistPath}. Run 'bun run typecheck' first.`);
  }

  const helpText = runOrThrow("node", [cliDistPath, "--help"], {
    cwd: repoRoot,
    step: "cli help smoke",
  });
  if (!helpText.includes("Brewva - AI-native coding agent CLI")) {
    throw new Error("cli help smoke failed: missing Brewva banner in dist output.");
  }

  const resolveScript = String.raw`
    import { createRequire } from "node:module";
    import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { dirname, join } from "node:path";
    const require = createRequire(import.meta.url);
    const packages = [
      "@brewva/brewva-runtime",
      "@brewva/brewva-search",
      "@brewva/brewva-session-index",
      "@brewva/brewva-session-index/evidence",
      "@brewva/brewva-recall",
      "@brewva/brewva-recall/broker",
      "@brewva/brewva-recall/knowledge",
      "@brewva/brewva-recall/evidence",
      "@brewva/brewva-channels-telegram",
      "@brewva/brewva-ingress-telegram",
      "@brewva/brewva-tools",
      "@brewva/brewva-tools/contracts",
      "@brewva/brewva-tools/registry",
      "@brewva/brewva-tools/runtime-port",
      "@brewva/brewva-tools/navigation",
      "@brewva/brewva-tools/execution",
      "@brewva/brewva-tools/memory",
      "@brewva/brewva-tools/delegation",
      "@brewva/brewva-tools/workflow",
      "@brewva/brewva-runtime/channels",
      "@brewva/brewva-runtime/claim",
      "@brewva/brewva-runtime/config",
      "@brewva/brewva-runtime/conventions",
      "@brewva/brewva-runtime/core",
      "@brewva/brewva-runtime/cost",
      "@brewva/brewva-runtime/delegation",
      "@brewva/brewva-runtime/events",
      "@brewva/brewva-runtime/governance",
      "@brewva/brewva-runtime/ledger",
      "@brewva/brewva-runtime/projection",
      "@brewva/brewva-runtime/proposals",
      "@brewva/brewva-runtime/reasoning",
      "@brewva/brewva-runtime/recovery",
      "@brewva/brewva-runtime/schedule",
      "@brewva/brewva-runtime/security",
      "@brewva/brewva-runtime/session",
      "@brewva/brewva-runtime/skills",
      "@brewva/brewva-runtime/tape",
      "@brewva/brewva-runtime/task",
      "@brewva/brewva-runtime/tools",
      "@brewva/brewva-runtime/verification",
      "@brewva/brewva-runtime/workbench",
      "@brewva/brewva-gateway/channels",
      "@brewva/brewva-gateway/hosted",
      "@brewva/brewva-gateway/policy/model-routing",
      "@brewva/brewva-gateway/extensions",
      "@brewva/brewva-cli",
      "@brewva/brewva-cli/entry",
      "@brewva/brewva-cli/commands",
      "@brewva/brewva-cli/channel",
      "@brewva/brewva-cli/extensions",
      "@brewva/brewva-cli/io/json-lines",
      "@brewva/brewva-gateway",
    ];
    const resolved = packages.map((name) => ({ name, path: require.resolve(name) }));
    for (const entry of resolved) {
      if (!entry.path.includes("/dist/")) {
        throw new Error("expected dist entrypoint, got " + entry.path);
      }
    }
    const [
      cliModule,
      cliEntryModule,
      cliCommandsModule,
      cliChannelModule,
      cliExtensionsModule,
      cliJsonLinesModule,
      channelsModule,
      hostModule,
      extensionsModule,
      gatewayModule,
      runtimeChannelsModule,
      runtimeRecoveryModule,
    ] = await Promise.all([
      import("@brewva/brewva-cli"),
      import("@brewva/brewva-cli/entry"),
      import("@brewva/brewva-cli/commands"),
      import("@brewva/brewva-cli/channel"),
      import("@brewva/brewva-cli/extensions"),
      import("@brewva/brewva-cli/io/json-lines"),
      import("@brewva/brewva-gateway/channels"),
      import("@brewva/brewva-gateway/hosted"),
      import("@brewva/brewva-gateway/extensions"),
      import("@brewva/brewva-gateway"),
      import("@brewva/brewva-runtime/channels"),
      import("@brewva/brewva-runtime/recovery"),
      ...packages
        .filter(
          (name) =>
            name !== "@brewva/brewva-cli" &&
            name !== "@brewva/brewva-cli/entry" &&
            name !== "@brewva/brewva-cli/commands" &&
            name !== "@brewva/brewva-cli/channel" &&
            name !== "@brewva/brewva-cli/extensions" &&
            name !== "@brewva/brewva-cli/io/json-lines" &&
            name !== "@brewva/brewva-gateway/channels" &&
            name !== "@brewva/brewva-gateway/hosted" &&
            name !== "@brewva/brewva-gateway/extensions" &&
            name !== "@brewva/brewva-gateway" &&
            name !== "@brewva/brewva-runtime/channels" &&
            name !== "@brewva/brewva-runtime/recovery",
        )
        .map((name) => import(name)),
    ]);
    if (typeof channelsModule.runChannelMode !== "function") {
      throw new Error("gateway channels subpath missing runChannelMode export");
    }
    if (typeof hostModule.createHostedSession !== "function") {
      throw new Error("gateway host subpath missing createHostedSession export");
    }
    if (typeof extensionsModule.defineHostedExtensionPlugin !== "function") {
      throw new Error("gateway extensions subpath missing defineHostedExtensionPlugin export");
    }
    if (typeof cliModule.parseArgs !== "function") {
      throw new Error("cli root entry missing parseArgs export");
    }
    if (typeof cliEntryModule.runCliRootEffect !== "function") {
      throw new Error("cli entry subpath missing runCliRootEffect export");
    }
    if (typeof cliCommandsModule.runOnboardCli !== "function") {
      throw new Error("cli commands subpath missing runOnboardCli export");
    }
    if (typeof cliChannelModule.handleInspectChannelCommand !== "function") {
      throw new Error("cli channel subpath missing handleInspectChannelCommand export");
    }
    if (typeof cliExtensionsModule.createInspectCommandExtension !== "function") {
      throw new Error("cli extensions subpath missing createInspectCommandExtension export");
    }
    if (typeof cliJsonLinesModule.writeJsonLine !== "function") {
      throw new Error("cli json-lines subpath missing writeJsonLine export");
    }
    if (typeof runtimeChannelsModule.normalizeChannelId !== "function") {
      throw new Error("runtime channels subpath missing normalizeChannelId export");
    }
    if (typeof runtimeRecoveryModule.createRecoveryWalStore !== "function") {
      throw new Error("runtime recovery subpath missing createRecoveryWalStore export");
    }
    if (
      "createBrewvaSession" in cliModule ||
      "registerRuntimeCoreEventBridge" in cliModule ||
      "writeJsonLine" in cliModule ||
      "createInspectCommandExtension" in cliModule ||
      "handleInspectChannelCommand" in cliModule
    ) {
      throw new Error("cli root entry unexpectedly re-exported gateway host helpers");
    }
    const cliInternalRuntime = await import("@brewva/brewva-cli/internal-shell-runtime");
    if (typeof cliInternalRuntime.runCliInteractiveSmoke !== "function") {
      throw new Error("cli internal runtime stub missing runCliInteractiveSmoke");
    }
    const cliRuntimeMessage = await cliInternalRuntime
      .runCliInteractiveSmoke()
      .then(() => "")
      .catch((error) => (error instanceof Error ? error.message : String(error)));
    if (!cliRuntimeMessage.includes("direct Node.js dist execution")) {
      throw new Error("cli internal runtime import did not resolve to the Node-safe stub");
    }
    if ("registerRuntimeCoreEventBridge" in hostModule) {
      throw new Error("gateway host subpath still exports removed session event bridge helper");
    }
    if ("createHostedSession" in gatewayModule || "createHostedBehaviorHostAdapter" in gatewayModule) {
      throw new Error("gateway root entry unexpectedly re-exported subpath-only APIs");
    }
    const isolatedHome = mkdtempSync(join(tmpdir(), "brewva-dist-home-"));
    const isolatedWorkspace = mkdtempSync(join(tmpdir(), "brewva-dist-workspace-"));
    mkdirSync(join(isolatedWorkspace, ".git"), { recursive: true });
    process.env.BREWVA_CODING_AGENT_DIR = join(isolatedHome, "agent");
    const { tokenizeSearchQuery } = await import("@brewva/brewva-search");
    const tokenizerTokens = tokenizeSearchQuery("数据库连接失败");
    for (const requiredToken of ["数据库", "连接", "失败"]) {
      if (!tokenizerTokens.includes(requiredToken)) {
        throw new Error("dist tokenizer smoke failed: missing token " + requiredToken);
      }
    }
    const recallRootModule = await import("@brewva/brewva-recall");
    const recallBrokerModule = await import("@brewva/brewva-recall/broker");
    const recallKnowledgeModule = await import("@brewva/brewva-recall/knowledge");
    const recallEvidenceModule = await import("@brewva/brewva-recall/evidence");
    const sessionIndexEvidenceModule = await import("@brewva/brewva-session-index/evidence");
    if (!Array.isArray(recallRootModule.RECALL_SCOPE_VALUES)) {
      throw new Error("recall root dist entry missing shared vocabulary export");
    }
    if (
      "getOrCreateRecallBroker" in recallRootModule ||
      "createRecallContextProvider" in recallRootModule ||
      "executeKnowledgeSearch" in recallRootModule ||
      "classifyRecallTapeEvent" in recallRootModule
    ) {
      throw new Error("recall root dist entry unexpectedly re-exported implementation subpaths");
    }
    if (typeof recallBrokerModule.getOrCreateRecallBroker !== "function") {
      throw new Error("recall broker subpath missing getOrCreateRecallBroker export");
    }
    if (typeof recallKnowledgeModule.executeKnowledgeSearch !== "function") {
      throw new Error("recall knowledge subpath missing executeKnowledgeSearch export");
    }
    if (typeof recallEvidenceModule.classifyRecallTapeEvent !== "function") {
      throw new Error("recall evidence subpath missing classifyRecallTapeEvent export");
    }
    if (typeof sessionIndexEvidenceModule.buildSessionIndexEventSearchText !== "function") {
      throw new Error("session-index evidence subpath missing event search-text export");
    }
    const runtimeRootModule = await import("@brewva/brewva-runtime");
    const { createBrewvaRuntime } = runtimeRootModule;
    const runtimeConfigModule = await import("@brewva/brewva-runtime/config");
    const runtimeSessionModule = await import("@brewva/brewva-runtime/session");
    const runtimeTapeModule = await import("@brewva/brewva-runtime/tape");
    const { createOutputSearchTool } = await import("@brewva/brewva-tools/navigation");
    const runtime = createBrewvaRuntime({ cwd: isolatedWorkspace });
    if (typeof createBrewvaRuntime !== "function") {
      throw new Error("runtime root dist entry missing createBrewvaRuntime export");
    }
    if (
      "BrewvaRuntime" in runtimeRootModule ||
      "createHostedRuntimePort" in runtimeRootModule ||
      "createToolRuntimePort" in runtimeRootModule ||
      "createOperatorRuntimePort" in runtimeRootModule
    ) {
      throw new Error("runtime root dist entry unexpectedly exported legacy runtime constructors");
    }
    if (
      !Object.isFrozen(runtime.root) ||
      !Object.isFrozen(runtime.hosted) ||
      !Object.isFrozen(runtime.tool)
    ) {
      throw new Error("runtime factory smoke failed: runtime ports are not frozen");
    }
    if ("getSemanticArtifactOutputContract" in runtimeRootModule || "buildTapeCheckpointPayload" in runtimeRootModule) {
      throw new Error("runtime root dist entry unexpectedly re-exported semantic artifact catalog helpers");
    }
    if (typeof runtimeConfigModule.loadBrewvaConfig !== "function") {
      throw new Error("runtime config subpath missing loadBrewvaConfig export");
    }
    if (typeof runtimeSessionModule.deriveSessionLineageState !== "function") {
      throw new Error("runtime session subpath missing deriveSessionLineageState export");
    }
    if (typeof runtimeTapeModule.buildTapeCheckpointPayload !== "function") {
      throw new Error("runtime tape subpath missing buildTapeCheckpointPayload export");
    }
    if (!existsSync(join(isolatedHome, "skills", ".system"))) {
      throw new Error("runtime construction smoke failed: system skill root was not installed");
    }
    if (!existsSync(join(isolatedHome, "skills", ".system.marker.json"))) {
      throw new Error("runtime construction smoke failed: system skill marker was not written");
    }
    const sessionId = "dist-output-search-cjk";
    const artifactRef = ".orchestrator/tool-output-artifacts/dist-cjk/100-exec-call.txt";
    const artifactPath = join(isolatedWorkspace, artifactRef);
    const artifactText = "服务启动中\n数据库连接被拒绝，连接失败需要重试\n";
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, artifactText, "utf8");
    const toolRuntime = runtime.tool;
    toolRuntime.extensions.tools.recordEvent({
      sessionId,
      type: "tool_output_artifact_persisted",
      payload: {
        toolName: "exec",
        artifactRef,
        rawBytes: Buffer.byteLength(artifactText, "utf8"),
      },
    });
    const outputSearchTool = createOutputSearchTool({
      runtime: toolRuntime,
    });
    const outputSearchResult = await outputSearchTool.execute(
      "dist-output-search-cjk",
      { query: "数据库连接失败", limit: 1 },
      undefined,
      undefined,
      {
        cwd: isolatedWorkspace,
        sessionManager: {
          getSessionId() {
            return sessionId;
          },
        },
      },
    );
    const outputSearchText = outputSearchResult.content.find((item) => item.type === "text")?.text ?? "";
    if (!outputSearchText.includes("数据库连接") || !outputSearchText.includes("连接失败")) {
      throw new Error("dist output_search smoke failed: Chinese artifact was not matched");
    }
    const { createSessionIndex } = await import("@brewva/brewva-session-index");
    const sessionIndex = await createSessionIndex({
      workspaceRoot: isolatedWorkspace,
      events: runtime.root.inspect.events,
      task: runtime.root.inspect.task,
      dbPath: join(isolatedWorkspace, ".brewva", "session-index", "dist-smoke.duckdb"),
    });
    const sessionIndexStatus = await sessionIndex.catchUp();
    await sessionIndex.close();
    if (!sessionIndexStatus.ok) {
      throw new Error(
        "dist session-index smoke failed: " +
          sessionIndexStatus.error +
          " " +
          sessionIndexStatus.message,
      );
    }
    if (sessionIndexStatus.indexedSessions < 1 || sessionIndexStatus.indexedEvents < 1) {
      throw new Error("dist session-index smoke failed: expected indexed session events");
    }
    console.log(JSON.stringify(resolved));
  `;

  runOrThrow("node", ["--input-type=module", "--eval", resolveScript], {
    cwd: repoRoot,
    step: "dist package import smoke",
  });

  assertNoPiEraMarkers([
    ...collectTextFiles(resolve(repoRoot, "distribution")),
    ...collectTextFiles(resolve(repoRoot, "packages", "brewva-cli", "runtime-assets")),
  ]);
  assertNoForbiddenMarkers(
    [...collectTextFiles(resolve(repoRoot, "distribution"))],
    DIST_REMOVED_EXEC_MARKERS,
    "dist removed exec runtime marker check failed",
  );
  assertNoForbiddenMarkers(
    [...collectTextFiles(resolve(repoRoot, "packages", "brewva-cli", "dist"))],
    NODE_SAFE_DIST_FORBIDDEN_MARKERS,
    "node-safe dist quarantine check failed",
  );

  console.log("dist smoke checks passed");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
