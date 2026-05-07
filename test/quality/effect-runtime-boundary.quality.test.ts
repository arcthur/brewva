import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const packagesRoot = resolve(repoRoot, "packages");
const effectPackageRoot = resolve(packagesRoot, "brewva-effect");

const EFFECT_VERSION = "4.0.0-beta.60";
const EFFECT_PACKAGES = ["effect", "@effect/opentelemetry", "@effect/platform-node"] as const;

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

function listPackageJsonPaths(): string[] {
  return readdirSync(packagesRoot)
    .map((entry) => resolve(packagesRoot, entry, "package.json"))
    .filter((path) => existsSync(path))
    .toSorted((left, right) => left.localeCompare(right));
}

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const absolutePath = resolve(directory, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      if (entry === "dist" || entry === "node_modules") continue;
      files.push(...listSourceFiles(absolutePath));
      continue;
    }
    if (stats.isFile() && /\.(?:ts|tsx)$/u.test(entry)) {
      files.push(absolutePath);
    }
  }
  return files;
}

function listRepoFiles(directories: string[], extensions: readonly string[]): string[] {
  return directories.flatMap((directory) =>
    listSourceFiles(resolve(repoRoot, directory))
      .map((path) => path.replace(`${repoRoot}/`, ""))
      .filter((path) => extensions.some((extension) => path.endsWith(extension))),
  );
}

describe("Effect runtime foundation boundary", () => {
  test("brewva-effect is a workspace package with exact Effect v4 beta dependencies", () => {
    const packageJsonPath = resolve(effectPackageRoot, "package.json");
    expect(existsSync(packageJsonPath)).toBe(true);

    const manifest = readJson(packageJsonPath);
    expect(manifest["name"]).toBe("@brewva/brewva-effect");

    const dependencies = manifest["dependencies"] as Record<string, string> | undefined;
    expect(dependencies).toBeDefined();
    for (const packageName of EFFECT_PACKAGES) {
      expect(dependencies?.[packageName]).toBe(EFFECT_VERSION);
    }
  });

  test("@effect platform packages are only direct dependencies of brewva-effect", () => {
    const offenders: string[] = [];
    for (const packageJsonPath of listPackageJsonPaths()) {
      const manifest = readJson(packageJsonPath);
      const manifestName = typeof manifest["name"] === "string" ? manifest["name"] : "<unknown>";
      if (manifestName === "@brewva/brewva-effect") continue;
      const dependencies = manifest["dependencies"] as Record<string, string> | undefined;
      const devDependencies = manifest["devDependencies"] as Record<string, string> | undefined;
      for (const packageName of ["@effect/opentelemetry", "@effect/platform-node"] as const) {
        if (dependencies?.[packageName] || devDependencies?.[packageName]) {
          offenders.push(`${manifestName} -> ${packageName}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("@effect platform imports are isolated to brewva-effect source", () => {
    const offenders: string[] = [];
    for (const sourceFile of listSourceFiles(packagesRoot)) {
      if (sourceFile.startsWith(`${effectPackageRoot}/`)) continue;
      const source = readFileSync(sourceFile, "utf-8");
      for (const match of source.matchAll(/from\s+["'](@effect\/[^"']+)["']/gu)) {
        offenders.push(`${sourceFile.replace(`${repoRoot}/`, "")} -> ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("raw Effect imports stay isolated behind brewva-effect", () => {
    const offenders: string[] = [];
    for (const sourceFile of listSourceFiles(packagesRoot)) {
      if (sourceFile.startsWith(`${effectPackageRoot}/`)) continue;
      const source = readFileSync(sourceFile, "utf-8");
      if (/from\s+["']effect(?:\/[^"']+)?["']/u.test(source)) {
        offenders.push(sourceFile.replace(`${repoRoot}/`, ""));
      }
    }
    expect(offenders).toEqual([]);
  });

  test("brewva-effect has a modular foundation spine with explicit package entrypoints", () => {
    const manifest = readJson(join(effectPackageRoot, "package.json"));
    const exports = manifest["exports"] as Record<string, unknown>;
    const rootSource = readFileSync(join(effectPackageRoot, "src/index.ts"), "utf8");
    const platformSource = readFileSync(join(effectPackageRoot, "src/platform-node.ts"), "utf8");
    const observabilitySource = readFileSync(
      join(effectPackageRoot, "src/observability.ts"),
      "utf8",
    );
    const scopesSource = readFileSync(join(effectPackageRoot, "src/scopes.ts"), "utf8");
    const retrySource = readFileSync(join(effectPackageRoot, "src/retry.ts"), "utf8");
    const edgeRunnerSource = readFileSync(join(effectPackageRoot, "src/edge-runner.ts"), "utf8");
    const runtimeSpineSource = readFileSync(
      join(effectPackageRoot, "src/runtime-spine.ts"),
      "utf8",
    );
    const testingSource = readFileSync(join(effectPackageRoot, "src/testing.ts"), "utf8");

    expect(exports["./edge"]).toBeDefined();
    expect(exports["./edge-runner"]).toBeDefined();
    expect(exports["./platform-node"]).toBeDefined();
    expect(exports["./runtime"]).toBeDefined();
    expect(exports["./testing"]).toBeDefined();

    expect(
      rootSource.split("\n").filter((line) => line.trim().length > 0).length,
    ).toBeLessThanOrEqual(16);
    expect(rootSource).toContain('export * from "./aliases.js";');
    expect(rootSource).toContain('export * from "./boundary.js";');
    expect(rootSource).toContain('export * from "./edge-runner.js";');
    expect(rootSource).toContain('export * from "./scopes.js";');
    expect(rootSource).not.toContain('from "@effect/opentelemetry"');
    expect(rootSource).not.toContain('from "@effect/platform-node/');
    expect(rootSource).not.toContain("ManagedRuntime.make");

    expect(platformSource).toContain('from "@effect/platform-node/NodeFileSystem"');
    expect(platformSource).toContain("export const nodeFileSystemLayer");
    expect(platformSource).toContain("export const nodeChildProcessSpawnerLayer");
    expect(platformSource).toContain("export async function loadNodeHttpClientLayer()");
    expect(platformSource).toContain("export async function loadNodeOpenTelemetryLayer(");
    expect(platformSource).toContain('import("@effect/opentelemetry")');
    expect(observabilitySource).toContain("export function observabilityLayer(");
    expect(observabilitySource).not.toContain('from "@effect/opentelemetry"');
    expect(observabilitySource).not.toContain('import("@effect/opentelemetry")');
    expect(observabilitySource).toContain("makeNodeSdkLayer");
    expect(observabilitySource).toContain("export function withBrewvaObservability");
    expect(observabilitySource).toContain("export const emptyObservabilityLayer");
    expect(scopesSource).toContain("export class BrewvaSessionScope");
    expect(scopesSource).toContain("export class BrewvaWorkerScope");
    expect(scopesSource).toContain("export class BrewvaProviderRequestScope");
    expect(scopesSource).toContain("export class BrewvaBoxScope");
    expect(retrySource).toContain("export function retryWithBrewvaPolicy");
    expect(retrySource).toContain("export function makeBrewvaRetrySchedule");
    expect(edgeRunnerSource).toContain("export function runEdgeOperation");
    expect(edgeRunnerSource).toContain("export function runEdgeOperationSync");
    expect(edgeRunnerSource).toContain("export interface BrewvaEdgeOperationOptions");
    expect(runtimeSpineSource).toContain("export function createBrewvaRuntimeSpine");
    expect(runtimeSpineSource).toContain("ManagedRuntime.make");
    expect(testingSource).toContain("export function createTestRuntime");
    expect(testingSource).toContain("BrewvaTestClock");
  });

  test("provider streams have no Promise-first event stream compatibility class", () => {
    const obsoleteStreamPath = join(
      repoRoot,
      "packages/brewva-provider-core/src/utils/event-stream.ts",
    );
    expect(existsSync(obsoleteStreamPath)).toBe(false);

    const references = listRepoFiles(["packages"], [".ts", ".tsx"]).filter((file) =>
      readFileSync(join(repoRoot, file), "utf8").includes("AssistantMessageEventStream"),
    );
    expect(references).toEqual([]);
  });

  test("provider stream runner links Effect interruption to provider AbortSignals", () => {
    const source = readFileSync(
      join(repoRoot, "packages/brewva-provider-core/src/stream/run-provider-stream.ts"),
      "utf8",
    );
    const codexResponsesSource = readFileSync(
      join(
        repoRoot,
        "packages/brewva-provider-core/src/providers/openai-codex-responses/adapter.ts",
      ),
      "utf8",
    );
    const googleGeminiCliSource = readFileSync(
      join(repoRoot, "packages/brewva-provider-core/src/providers/google-gemini-cli/adapter.ts"),
      "utf8",
    );

    expect(source).toContain("runWithLinkedAbortSignal(");
    expect(source).toContain("effectSignal");
    expect(source).toContain("options.signal");
    expect(source).toContain("signal,");
    expect(source).toContain("async push(event)");
    expect(source).toContain("BrewvaQueue.offer(queue, event)");
    expect(source).toContain("BrewvaProviderRequestScope.layer");
    expect(source).toContain('withBrewvaObservability("brewva.provider.stream"');
    expect(source).toContain('withBrewvaObservability("brewva.provider.producer"');
    expect(source).not.toContain("offerUnsafe");
    expect(source).toContain("Provider stream buffer is full or closed");
    expect(source).toContain("BrewvaQueue.failCauseUnsafe");
    expect(codexResponsesSource).toContain("fetchCodexSseResponseEffect");
    expect(codexResponsesSource).toContain("retryWithBrewvaPolicy");
    expect(codexResponsesSource).not.toContain("function sleep(");
    expect(googleGeminiCliSource).toContain("fetchGoogleGeminiCliResponseEffect");
    expect(googleGeminiCliSource).toContain("retryWithBrewvaPolicy");
    expect(googleGeminiCliSource).toContain("delayFor:");
    expect(googleGeminiCliSource).toContain("extractRetryDelay(errorText, response)");
    expect(googleGeminiCliSource).not.toContain("node:timers/promises");
  });

  test("substrate turn runtime core is Effect-returning", () => {
    const loopSource = readFileSync(
      join(repoRoot, "packages/brewva-substrate/src/turn/loop.ts"),
      "utf8",
    );
    const assistantStreamSource = readFileSync(
      join(repoRoot, "packages/brewva-substrate/src/turn/assistant-stream.ts"),
      "utf8",
    );
    const toolRunnerSource = readFileSync(
      join(repoRoot, "packages/brewva-substrate/src/turn/tool-runner.ts"),
      "utf8",
    );

    expect(loopSource).toContain("export function runBrewvaTurnLoop(");
    expect(loopSource).not.toContain("export async function runBrewvaTurnLoop(");
    expect(assistantStreamSource).toContain("export function streamAssistantResponse(");
    expect(assistantStreamSource).not.toContain("export async function streamAssistantResponse(");
    expect(toolRunnerSource).toContain("export function executeToolCalls(");
    expect(toolRunnerSource).not.toContain("export async function executeToolCalls(");
  });

  test("substrate turn events are dispatched through named Effect scopes", () => {
    const effectRuntimeSource = readFileSync(
      join(repoRoot, "packages/brewva-substrate/src/turn/effect-runtime.ts"),
      "utf8",
    );
    const loopSource = readFileSync(
      join(repoRoot, "packages/brewva-substrate/src/turn/loop.ts"),
      "utf8",
    );
    const assistantStreamSource = readFileSync(
      join(repoRoot, "packages/brewva-substrate/src/turn/assistant-stream.ts"),
      "utf8",
    );
    const toolRunnerSource = readFileSync(
      join(repoRoot, "packages/brewva-substrate/src/turn/tool-runner.ts"),
      "utf8",
    );
    const steerSource = readFileSync(
      join(repoRoot, "packages/brewva-substrate/src/turn/steer.ts"),
      "utf8",
    );
    const eventBusSource = readFileSync(
      join(repoRoot, "packages/brewva-substrate/src/execution/event-bus.ts"),
      "utf8",
    );

    expect(effectRuntimeSource).toContain("export class BrewvaTurnScope");
    expect(effectRuntimeSource).toContain("export class BrewvaToolInvocationScope");
    expect(effectRuntimeSource).toContain("export function createTurnEventDispatcher");
    expect(effectRuntimeSource).toContain("BrewvaEffect.forkScoped");
    expect(effectRuntimeSource).toContain("captureScope");
    expect(effectRuntimeSource).toContain("runTurnEventSinkBoundary");
    expect(effectRuntimeSource).toContain("fromAbortableBoundaryPromise");
    expect(effectRuntimeSource).toContain("sink(event, scope, signal)");
    expect(effectRuntimeSource).not.toContain("fromBoundaryPromise");
    expect(effectRuntimeSource).toContain("emitFromCallback");
    expect(loopSource).toContain("createTurnEventDispatcher(emit)");
    expect(loopSource).toContain("BrewvaTurnScope.layer");
    expect(loopSource).toContain('withBrewvaObservability("brewva.turn.loop"');
    expect(toolRunnerSource).toContain("BrewvaToolInvocationScope.layer");
    expect(toolRunnerSource).toContain("withToolInvocationScope");
    expect(toolRunnerSource).toContain("callbackScope");
    expect(toolRunnerSource).not.toContain("fromBoundaryPromise");
    expect(eventBusSource).toContain("metadata?: TMetadata");
    expect(loopSource).toContain("fromAbortableBoundaryPromise");
    expect(loopSource).not.toContain("fromBoundaryPromise");
    expect(assistantStreamSource).toContain("fromAbortableBoundaryPromise");
    expect(assistantStreamSource).not.toContain("fromBoundaryPromise");
    expect(steerSource).toContain("consumePendingSteerEffect");
    expect(steerSource).not.toContain("fromBoundaryPromise");

    for (const source of [loopSource, assistantStreamSource, toolRunnerSource, steerSource]) {
      expect(source).not.toContain("fromBoundaryPromise(() => emit");
      expect(source).not.toContain("fromBoundaryPromise(() =>\n        emit");
    }
  });

  test("gateway supervisor loops use Brewva scoped schedule handles", () => {
    const sessionSupervisorSource = readFileSync(
      join(repoRoot, "packages/brewva-gateway/src/daemon/session-supervisor.ts"),
      "utf8",
    );
    const gatewayDaemonSource = readFileSync(
      join(repoRoot, "packages/brewva-gateway/src/daemon/gateway-daemon.ts"),
      "utf8",
    );
    const heartbeatPolicySource = readFileSync(
      join(repoRoot, "packages/brewva-gateway/src/daemon/heartbeat-policy.ts"),
      "utf8",
    );
    const workerMainSource = readFileSync(
      join(repoRoot, "packages/brewva-gateway/src/session/worker-main.ts"),
      "utf8",
    );
    const channelLifecycleSource = readFileSync(
      join(repoRoot, "packages/brewva-gateway/src/channels/channel-host-lifecycle.ts"),
      "utf8",
    );
    const taskWatchdogSource = readFileSync(
      join(repoRoot, "packages/brewva-gateway/src/session/task-progress-watchdog.ts"),
      "utf8",
    );
    const workerRpcSource = readFileSync(
      join(repoRoot, "packages/brewva-gateway/src/daemon/session-supervisor/worker-rpc.ts"),
      "utf8",
    );
    const workerStateSource = readFileSync(
      join(repoRoot, "packages/brewva-gateway/src/daemon/session-supervisor/worker-state.ts"),
      "utf8",
    );

    for (const source of [
      sessionSupervisorSource,
      gatewayDaemonSource,
      heartbeatPolicySource,
      workerMainSource,
      channelLifecycleSource,
      taskWatchdogSource,
    ]) {
      expect(source).toContain("startScopedSchedule");
      expect(source).not.toContain("startManagedInterval");
      expect(source).not.toContain("setInterval(");
      expect(source).not.toContain("clearInterval(");
    }
    expect(workerRpcSource).toContain("requestEffect(");
    expect(workerRpcSource).toContain("registerPendingTurnEffect(");
    expect(workerRpcSource).toContain("BrewvaWorkerScope.layer");
    expect(workerRpcSource).toContain("BrewvaScope.provide(handle.scope)");
    expect(workerRpcSource).toContain("withWorkerRpcObservability");
    expect(workerRpcSource).toContain("BrewvaDeferred.make");
    expect(workerRpcSource).toContain("BrewvaEffect.race");
    expect(workerRpcSource).toContain("BrewvaDuration.millis");
    expect(workerRpcSource).not.toContain("new Promise((resolveRequest");
    expect(workerRpcSource).not.toContain("new Promise((resolveTurn");
    expect(sessionSupervisorSource).not.toContain("new Promise<WorkerReadyPayload");
    expect(workerStateSource).toContain("BrewvaDeferred.Deferred");
    expect(workerStateSource).toContain("BrewvaScope.Scope");
    expect(workerStateSource).not.toContain("readyResolve");
    expect(workerStateSource).not.toContain("readyReject");
    expect(workerStateSource).not.toContain("readyTimer");
    expect(workerStateSource).not.toContain("timer: ReturnType<typeof setTimeout>");
    expect(sessionSupervisorSource).toContain("private readonly supervisorScope");
    expect(sessionSupervisorSource).toContain("BrewvaScope.fork(this.supervisorScope)");
    expect(sessionSupervisorSource).toContain("BrewvaScope.addFinalizer(");
    expect(sessionSupervisorSource).toContain("BrewvaScope.close(handle.scope");
    expect(gatewayDaemonSource).toContain("BrewvaGatewayScope.layer");
    expect(gatewayDaemonSource).toContain('withBrewvaObservability("brewva.gateway.daemon"');
    expect(gatewayDaemonSource).toContain("`brewva.gateway.${operation}`");
  });

  test("public Node and Bun edges run one Effect operation per logical boundary", () => {
    const cliSource = readFileSync(join(repoRoot, "packages/brewva-cli/src/index.ts"), "utf8");
    const gatewayCliSource = readFileSync(
      join(repoRoot, "packages/brewva-gateway/src/cli.ts"),
      "utf8",
    );
    const channelHostSource = readFileSync(
      join(repoRoot, "packages/brewva-gateway/src/channels/host.ts"),
      "utf8",
    );
    const channelLifecycleSource = readFileSync(
      join(repoRoot, "packages/brewva-gateway/src/channels/channel-host-lifecycle.ts"),
      "utf8",
    );
    const channelBootstrapSource = readFileSync(
      join(repoRoot, "packages/brewva-gateway/src/channels/channel-bootstrap.ts"),
      "utf8",
    );
    const channelSessionCoordinatorSource = readFileSync(
      join(repoRoot, "packages/brewva-gateway/src/channels/channel-session-coordinator.ts"),
      "utf8",
    );
    const channelTurnDispatcherSource = readFileSync(
      join(repoRoot, "packages/brewva-gateway/src/channels/channel-turn-dispatcher.ts"),
      "utf8",
    );
    const channelEffectQueueSource = readFileSync(
      join(repoRoot, "packages/brewva-gateway/src/channels/effect-serial-queue.ts"),
      "utf8",
    );
    const workerMainSource = readFileSync(
      join(repoRoot, "packages/brewva-gateway/src/session/worker-main.ts"),
      "utf8",
    );

    expect(cliSource).toContain("runCliRootEffect");
    expect(cliSource).toContain('runEdgeOperation("brewva.cli.root"');
    expect(cliSource).toContain("startScopedTimeout");
    expect(cliSource).not.toContain("setTimeout(");
    expect(cliSource).not.toContain("clearTimeout(");
    expect(cliSource).not.toContain("void run().catch");
    expect(gatewayCliSource).toContain("runGatewayCliEffect");
    expect(gatewayCliSource).toContain('runEdgeOperation("brewva.gateway.cli"');
    expect(channelHostSource).toContain("runChannelModeEffect");
    expect(channelHostSource).toContain('runEdgeOperation("brewva.channel.mode"');
    expect(channelLifecycleSource).toContain("runChannelHostLifecycleEffect");
    expect(channelLifecycleSource).toContain('runEdgeOperation("brewva.channel.host.lifecycle"');
    expect(channelLifecycleSource).toContain("addScopedFinalizer(");
    expect(channelLifecycleSource).toContain("fromAbortableBoundaryPromise");
    expect(channelLifecycleSource).not.toContain("new Promise<void>((resolve, reject)");
    expect(channelBootstrapSource).toContain("listenServerEffect");
    expect(channelBootstrapSource).toContain("closeServerEffect");
    expect(channelBootstrapSource).not.toContain("new Promise<void>((resolve, reject)");
    expect(channelSessionCoordinatorSource).toContain("createChannelEffectSerialQueue");
    expect(channelSessionCoordinatorSource).not.toContain("queueTail");
    expect(channelSessionCoordinatorSource).not.toContain("new Map<string, Promise<void>>");
    expect(channelTurnDispatcherSource).toContain("createChannelEffectSerialQueue");
    expect(channelTurnDispatcherSource).not.toContain("scopeQueues = new Map<string, Promise");
    expect(channelEffectQueueSource).toContain("BrewvaQueue.unbounded");
    expect(channelEffectQueueSource).toContain("BrewvaDeferred.make");
    expect(channelEffectQueueSource).toContain("BrewvaScope.make");
    expect(workerMainSource).toContain("handleWorkerMessageEffect");
    expect(workerMainSource).toContain("runWorkerEdgeOperation");
    expect(workerMainSource).toContain("return runEdgeOperation(");
    expect(workerMainSource).toContain("`brewva.gateway.worker.${operation}`");
    expect(workerMainSource).toContain('process.on("message", (message) => {');
    expect(workerMainSource).not.toContain("void handleMessage(message)");
    expect(workerMainSource).not.toContain('void shutdown(0, "parent_disconnected")');
  });

  test("remaining public edge work runs through Effect edge operations", () => {
    const effectPackageJson = readJson(join(effectPackageRoot, "package.json"));
    const effectExports = effectPackageJson["exports"] as Record<string, unknown>;
    const platformEdgeSource = readFileSync(join(effectPackageRoot, "src/edge.ts"), "utf8");
    const cliRuntimeSource = readFileSync(
      join(repoRoot, "packages/brewva-cli/src/cli-runtime.ts"),
      "utf8",
    );
    const cliOnboardSource = readFileSync(
      join(repoRoot, "packages/brewva-cli/src/onboard.ts"),
      "utf8",
    );
    const cliDaemonSource = readFileSync(
      join(repoRoot, "packages/brewva-cli/src/daemon-mode.ts"),
      "utf8",
    );
    const gatewayPrintSource = readFileSync(
      join(repoRoot, "packages/brewva-cli/src/gateway-print.ts"),
      "utf8",
    );
    const bunShellRuntimeSource = readFileSync(
      join(repoRoot, "packages/brewva-cli/runtime/internal-shell-runtime.ts"),
      "utf8",
    );
    const nodeShellRuntimeSource = readFileSync(
      join(repoRoot, "packages/brewva-cli/src/internal-shell-runtime.ts"),
      "utf8",
    );
    const shellRuntimeSource = readFileSync(
      join(repoRoot, "packages/brewva-cli/src/shell/runtime.ts"),
      "utf8",
    );
    const shellClipboardSource = readFileSync(
      join(repoRoot, "packages/brewva-cli/src/shell/clipboard.ts"),
      "utf8",
    );
    const telegramTransportSource = readFileSync(
      join(repoRoot, "packages/brewva-channels-telegram/src/http-transport.ts"),
      "utf8",
    );
    const ingressSource = readFileSync(
      join(repoRoot, "packages/brewva-ingress/src/telegram-ingress.ts"),
      "utf8",
    );
    const workerWebhookSource = readFileSync(
      join(repoRoot, "packages/brewva-ingress/src/telegram-webhook-worker.ts"),
      "utf8",
    );
    const mcpAdapterSource = readFileSync(
      join(repoRoot, "packages/brewva-mcp-adapter/src/index.ts"),
      "utf8",
    );
    const hostPluginRunnerSource = readFileSync(
      join(repoRoot, "packages/brewva-substrate/src/host-api/plugin-runner.ts"),
      "utf8",
    );

    expect(effectExports["./edge"]).toBeDefined();
    expect(platformEdgeSource).toContain("runPlatformEdgeOperation");
    expect(platformEdgeSource).toContain("runPlatformEdgeOperationSync");
    expect(platformEdgeSource).not.toContain("@effect/platform-node");

    expect(cliRuntimeSource).toContain("runCliInteractiveShellEffect");
    expect(cliRuntimeSource).toContain("runEdgeOperation(");
    expect(cliRuntimeSource).toContain('"brewva.cli.interactive"');
    expect(cliOnboardSource).toContain("runOnboardCliEffect");
    expect(cliOnboardSource).toContain('runEdgeOperation("brewva.cli.onboard"');
    expect(cliOnboardSource).toContain("runGatewayCliOperation");
    expect(cliOnboardSource).not.toContain("runGatewayCli(");
    expect(cliDaemonSource).toContain("startScopedSchedule");
    expect(cliDaemonSource).not.toContain("setInterval(");
    expect(cliDaemonSource).not.toContain("clearInterval(");
    expect(gatewayPrintSource).toContain("startScopedTimeout");
    expect(gatewayPrintSource).not.toContain("setTimeout(");
    expect(gatewayPrintSource).not.toContain("clearTimeout(");
    expect(bunShellRuntimeSource).toContain("runCliInteractiveSessionEffect");
    expect(bunShellRuntimeSource).toContain("runCliInteractiveSessionOperation");
    expect(nodeShellRuntimeSource).toContain("runCliInteractiveSessionEffect");
    expect(nodeShellRuntimeSource).toContain("runCliInteractiveSessionOperation");
    expect(shellRuntimeSource).toContain("startScopedSchedule");
    expect(shellRuntimeSource).toContain("startScopedTimeout");
    expect(shellRuntimeSource).not.toContain("setInterval(");
    expect(shellRuntimeSource).not.toContain("clearInterval(");
    expect(shellRuntimeSource).not.toContain("setTimeout(");
    expect(shellRuntimeSource).not.toContain("clearTimeout(");
    expect(shellClipboardSource).toContain("startScopedTimeout");
    expect(shellClipboardSource).not.toContain("setTimeout(");
    expect(shellClipboardSource).not.toContain("clearTimeout(");
    expect(telegramTransportSource).toContain("sleepAtBoundary");
    expect(telegramTransportSource).not.toContain("setTimeout(");
    expect(telegramTransportSource).not.toContain("clearTimeout(");

    expect(ingressSource).toContain("handleTelegramIngressHttpRequestEffect");
    expect(ingressSource).toContain("runEdgeOperation(");
    expect(ingressSource).toContain('"brewva.ingress.telegram.http.request"');
    expect(ingressSource).toContain("fromBoundaryPromise");
    expect(ingressSource).not.toContain("BrewvaEffect.Effect<TelegramIngressResult, unknown>");
    expect(workerWebhookSource).toContain("handleTelegramWebhookFetchEffect");
    expect(workerWebhookSource).toContain("runPlatformEdgeOperation(");
    expect(workerWebhookSource).toContain('"brewva.ingress.telegram.worker.fetch"');
    expect(workerWebhookSource).not.toContain("BrewvaPlatformEdgeEffect");

    expect(mcpAdapterSource).toContain("withMcpOperationGuardEffect");
    expect(mcpAdapterSource).toContain("runEdgeOperation(");
    expect(mcpAdapterSource).toContain("`brewva.mcp.adapter.${operation}`");
    expect(mcpAdapterSource).toContain("fromAbortableBoundaryPromise");
    expect(mcpAdapterSource).toContain("McpAdapterRuntimeError");
    expect(mcpAdapterSource).not.toContain("BrewvaEffect.Effect<T, unknown>");
    expect(mcpAdapterSource).not.toContain("setTimeout(");
    expect(mcpAdapterSource).not.toContain("clearTimeout(");
    expect(hostPluginRunnerSource).toContain("runHostPluginHandlerEffect");
    expect(hostPluginRunnerSource).toContain("withBrewvaObservability(");
    expect(hostPluginRunnerSource).toContain("`brewva.host.plugin.${event}`");
    expect(hostPluginRunnerSource).toContain("fromAbortableBoundaryPromise");
    expect(hostPluginRunnerSource).toContain("BrewvaHostPluginHandlerError");
    expect(hostPluginRunnerSource).not.toContain("BrewvaEffect.Effect<unknown, unknown>");

    const hostPluginSource = readFileSync(
      join(repoRoot, "packages/brewva-substrate/src/host-api/plugin.ts"),
      "utf8",
    );
    expect(hostPluginSource).toContain("defineEffectInternalHostPlugin");
    expect(hostPluginSource).toContain("onEffect");
    expect(hostPluginSource).toContain("runPromiseAtBoundary");
    expect(hostPluginSource).not.toContain("BrewvaRuntimeScope");
  });

  test("tools process and exec lanes expose Effect-native runtime entrypoints", () => {
    const registrySource = readFileSync(
      join(repoRoot, "packages/brewva-tools/src/exec-process-registry.ts"),
      "utf8",
    );
    const hostLaneSource = readFileSync(
      join(repoRoot, "packages/brewva-tools/src/exec/host-lane.ts"),
      "utf8",
    );
    const boxLaneSource = readFileSync(
      join(repoRoot, "packages/brewva-tools/src/exec/box-lane.ts"),
      "utf8",
    );

    expect(registrySource).toContain("startManagedExecEffect");
    expect(registrySource).toContain("scopedManagedExec");
    expect(registrySource).toContain("startManagedBoxExecEffect");
    expect(registrySource).toContain("scopedManagedBoxExec");
    expect(registrySource).toContain("streamManagedSessionOutput");
    expect(registrySource).toContain("consumeManagedSessionOutputEffect");
    expect(registrySource).toContain("waitForManagedSessionActivityEffect");
    expect(registrySource).toContain("BrewvaStream.callback");
    expect(registrySource).toContain("startScopedTimeout");
    expect(registrySource).not.toContain("setTimeout(");
    expect(registrySource).not.toContain("clearTimeout(");
    expect(registrySource).not.toContain("function sleep(");
    expect(hostLaneSource).toContain("executeHostCommandEffect");
    expect(hostLaneSource).toContain("BrewvaSessionScope.layer");
    expect(hostLaneSource).toContain('withBrewvaObservability("brewva.tools.host.exec"');
    expect(hostLaneSource).toContain("BrewvaEffect.race");
    expect(hostLaneSource).not.toContain("Promise.race");
    expect(hostLaneSource).toContain("runPromiseAtBoundary(executeHostCommandEffect(input))");
    expect(boxLaneSource).toContain("executeBoxCommandEffect");
    expect(boxLaneSource).toContain("BrewvaBoxScope.layer");
    expect(boxLaneSource).toContain('withBrewvaObservability("brewva.tools.box.exec"');
    expect(boxLaneSource).toContain("runPromiseAtBoundary(executeBoxCommandEffect(input))");
    expect(boxLaneSource).toContain("BrewvaEffect.acquireRelease");
    expect(boxLaneSource).toContain("waitForBoxExecutionEffect");
    expect(boxLaneSource).not.toContain("executeBoxCommandPromise");
  });

  test("brewva runtime composition is available as an internal Effect layer", () => {
    const layerSource = readFileSync(
      join(repoRoot, "packages/brewva-runtime/src/runtime/effect-runtime-layer.ts"),
      "utf8",
    );
    const facadeSource = readFileSync(
      join(repoRoot, "packages/brewva-runtime/src/runtime/runtime-facade-state.ts"),
      "utf8",
    );

    expect(layerSource).toContain("RuntimeIdentityService extends BrewvaContext.Service");
    expect(layerSource).toContain("function createRuntimeBaseLayer");
    expect(layerSource).toContain("BrewvaRuntimeScope.layer");
    expect(layerSource).toContain("BrewvaLayer.effect(");
    expect(layerSource).toContain("BrewvaLayer.provide(");
    expect(layerSource).toContain("RuntimeConfigService extends BrewvaContext.Service");
    expect(layerSource).toContain("RuntimeBuildConfigService extends BrewvaContext.Service");
    expect(layerSource).toContain("RuntimeCompositionHooksService extends BrewvaContext.Service");
    expect(layerSource).toContain("RuntimeSecurityConfigService extends BrewvaContext.Service");
    expect(layerSource).toContain(
      "RuntimeInfrastructureConfigService extends BrewvaContext.Service",
    );
    expect(layerSource).toContain("RuntimeScheduleConfigService extends BrewvaContext.Service");
    expect(layerSource).toContain("RuntimeCoreDependenciesService extends BrewvaContext.Service");
    expect(layerSource).toContain("RuntimeKernelService extends BrewvaContext.Service");
    expect(layerSource).toContain(
      "RuntimeServiceDependenciesService extends BrewvaContext.Service",
    );
    expect(layerSource).toContain(
      "RuntimeLazyServiceFactoriesService extends BrewvaContext.Service",
    );
    expect(layerSource).not.toContain("class RuntimeServiceGraph");
    expect(layerSource).toContain("registerRuntimeCoreDependencies");
    expect(layerSource).toContain("registerRuntimeKernelContext");
    expect(layerSource).toContain("registerRuntimeServiceDependencies");
    expect(layerSource).toContain("registerRuntimeLazyServiceFactories");
    expect(layerSource).toContain("collectRuntimeComposition");
    expect(layerSource).toContain("createRuntimeEffectLayer");
    expect(layerSource).toContain("createRuntimeEffectSpine");
    expect(layerSource).not.toContain("runSyncAtBoundary");
    expect(facadeSource).toContain("createRuntimeEffectSpine");
    expect(facadeSource).toContain("effectRuntimeLayer");
    expect(facadeSource).toContain("effectRuntimeSpine");
    expect(facadeSource).toContain("runSync(collectRuntimeComposition())");
    expect(facadeSource).not.toContain("composeRuntimeDependencies");
    expect(facadeSource).toContain("export function getRuntimeEffectLayer");
    expect(facadeSource).toContain("export function getRuntimeEffectSpine");
  });

  test("recovery WAL maintenance has an Effect-native recovery entrypoint", () => {
    const walRecoverySource = readFileSync(
      join(repoRoot, "packages/brewva-runtime/src/domain/recovery/wal-recovery.ts"),
      "utf8",
    );
    const walMaintenanceSource = readFileSync(
      join(repoRoot, "packages/brewva-runtime/src/domain/recovery/wal-maintenance.ts"),
      "utf8",
    );
    const recoveryPortSource = readFileSync(
      join(repoRoot, "packages/brewva-runtime/src/recovery.ts"),
      "utf8",
    );

    expect(walRecoverySource).toContain("export class RecoveryWalRecoveryError");
    expect(walRecoverySource).toContain("recoverEffect()");
    expect(walRecoverySource).toContain("runPromiseAtBoundary(this.recoverEffect())");
    expect(walMaintenanceSource).toContain("export function recoverRecoveryWalEffect");
    expect(recoveryPortSource).toContain('"recoverEffect"');
  });
});
