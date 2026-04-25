#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, resolve } from "node:path";

const NODE_VERSION_RANGE = "^20.19.0 || >=22.12.0";

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
      "@brewva/brewva-channels-telegram",
      "@brewva/brewva-ingress",
      "@brewva/brewva-tools",
      "@brewva/brewva-tui",
      "@brewva/brewva-gateway/host",
      "@brewva/brewva-gateway/runtime-plugins",
      "@brewva/brewva-cli",
      "@brewva/brewva-gateway",
    ];
    const resolved = packages.map((name) => ({ name, path: require.resolve(name) }));
    for (const entry of resolved) {
      if (!entry.path.includes("/dist/")) {
        throw new Error("expected dist entrypoint, got " + entry.path);
      }
    }
    const [cliModule, tuiModule, hostModule, runtimePluginsModule, gatewayModule] = await Promise.all([
      import("@brewva/brewva-cli"),
      import("@brewva/brewva-tui"),
      import("@brewva/brewva-gateway/host"),
      import("@brewva/brewva-gateway/runtime-plugins"),
      import("@brewva/brewva-gateway"),
      ...packages
        .filter(
          (name) =>
            name !== "@brewva/brewva-cli" &&
            name !== "@brewva/brewva-tui" &&
            name !== "@brewva/brewva-gateway/host" &&
            name !== "@brewva/brewva-gateway/runtime-plugins" &&
            name !== "@brewva/brewva-gateway",
        )
        .map((name) => import(name)),
    ]);
    if (typeof hostModule.createHostedSession !== "function") {
      throw new Error("gateway host subpath missing createHostedSession export");
    }
    if (typeof runtimePluginsModule.createHostedTurnPipeline !== "function") {
      throw new Error("gateway runtime-plugins subpath missing createHostedTurnPipeline export");
    }
    if (typeof tuiModule.detectTerminalCapabilities !== "function") {
      throw new Error("tui root entry missing detectTerminalCapabilities export");
    }
    if (typeof tuiModule.createHeadlessTerminalHarness !== "function") {
      throw new Error("tui root entry missing createHeadlessTerminalHarness export");
    }
    if (typeof cliModule.parseArgs !== "function") {
      throw new Error("cli root entry missing parseArgs export");
    }
    if ("createBrewvaSession" in cliModule || "registerRuntimeCoreEventBridge" in cliModule) {
      throw new Error("cli root entry unexpectedly re-exported gateway host helpers");
    }
    const cliInternalRuntime = await import("@brewva/brewva-cli/internal-shell-runtime");
    const tuiInternalRuntime = await import("@brewva/brewva-tui/internal-opentui-runtime");
    if (typeof cliInternalRuntime.runCliInteractiveSmoke !== "function") {
      throw new Error("cli internal runtime stub missing runCliInteractiveSmoke");
    }
    if (typeof tuiInternalRuntime.runOpenTuiSmoke !== "function") {
      throw new Error("tui internal runtime stub missing runOpenTuiSmoke");
    }
    const cliRuntimeMessage = await cliInternalRuntime
      .runCliInteractiveSmoke()
      .then(() => "")
      .catch((error) => (error instanceof Error ? error.message : String(error)));
    const tuiRuntimeMessage = await tuiInternalRuntime
      .runOpenTuiSmoke()
      .then(() => "")
      .catch((error) => (error instanceof Error ? error.message : String(error)));
    if (!cliRuntimeMessage.includes("direct Node.js dist execution")) {
      throw new Error("cli internal runtime import did not resolve to the Node-safe stub");
    }
    if (!tuiRuntimeMessage.includes("native interactive runtime")) {
      throw new Error("tui internal runtime import did not resolve to the Node-safe stub");
    }
    if ("registerRuntimeCoreEventBridge" in hostModule) {
      throw new Error("gateway host subpath still exports removed session event bridge helper");
    }
    if ("createHostedSession" in gatewayModule || "createHostedTurnPipeline" in gatewayModule) {
      throw new Error("gateway root entry unexpectedly re-exported subpath-only APIs");
    }
    const isolatedHome = mkdtempSync(join(tmpdir(), "brewva-dist-home-"));
    const isolatedWorkspace = mkdtempSync(join(tmpdir(), "brewva-dist-workspace-"));
    mkdirSync(join(isolatedWorkspace, ".git"), { recursive: true });
    process.env.BREWVA_CODING_AGENT_DIR = join(isolatedHome, "agent");
    const { tokenizeSearchText } = await import("@brewva/brewva-search");
    const tokenizerTokens = tokenizeSearchText("数据库连接失败");
    for (const requiredToken of ["数据库", "连接", "失败"]) {
      if (!tokenizerTokens.includes(requiredToken)) {
        throw new Error("dist tokenizer smoke failed: missing token " + requiredToken);
      }
    }
    const { BrewvaRuntime, createToolRuntimePort } = await import("@brewva/brewva-runtime");
    const { createToolRuntimeInternalPort, recordRuntimeEvent } = await import("@brewva/brewva-runtime/internal");
    const { createOutputSearchTool } = await import("@brewva/brewva-tools");
    const runtime = new BrewvaRuntime({ cwd: isolatedWorkspace });
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
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "tool_output_artifact_persisted",
      payload: {
        toolName: "exec",
        artifactRef,
        rawBytes: Buffer.byteLength(artifactText, "utf8"),
      },
    });
    const outputSearchTool = createOutputSearchTool({
      runtime: {
        ...createToolRuntimePort(runtime),
        internal: createToolRuntimeInternalPort(runtime),
      },
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
      events: runtime.inspect.events,
      task: runtime.inspect.task,
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
    [
      ...collectTextFiles(resolve(repoRoot, "packages", "brewva-cli", "dist")),
      ...collectTextFiles(resolve(repoRoot, "packages", "brewva-tui", "dist")),
    ],
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
