import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("gateway contract: hosted session surface", () => {
  test("anchors the exported HostedSession type on substrate-owned prompt-session contracts", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const hostedBootstrapPath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "host",
      "hosted-session-bootstrap.ts",
    );
    const hostedDriverPath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "host",
      "hosted-session-driver.ts",
    );
    const hostedRuntimePath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "host",
      "hosted-session-runtime.ts",
    );
    const hostedBackendPath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "host",
      "hosted-session-backend.ts",
    );
    const hostedLocalBackendPath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "host",
      "hosted-session-backend-local.ts",
    );
    const managedSessionPath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "host",
      "managed-agent-session.ts",
    );
    const runtimeProjectionStorePath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "host",
      "runtime-projection-session-store.ts",
    );
    const hostedAgentEnginePath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "host",
      "hosted-agent-engine.ts",
    );
    const agentEnginePackagePath = resolve(
      repoRoot,
      "packages",
      "brewva-agent-engine",
      "package.json",
    );
    const agentEngineIndexPath = resolve(
      repoRoot,
      "packages",
      "brewva-agent-engine",
      "src",
      "index.ts",
    );
    const brewvaAgentEnginePath = resolve(
      repoRoot,
      "packages",
      "brewva-agent-engine",
      "src",
      "brewva-agent-engine.ts",
    );
    const providerStreamPath = resolve(
      repoRoot,
      "packages",
      "brewva-agent-engine",
      "src",
      "provider-stream.ts",
    );
    const hostedAuthStorePath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "host",
      "hosted-auth-store.ts",
    );
    const hostedModelRegistryPath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "host",
      "hosted-model-registry.ts",
    );
    const createHostedSessionPath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "host",
      "create-hosted-session.ts",
    );
    const gatewayPackageJsonPath = resolve(repoRoot, "packages", "brewva-gateway", "package.json");

    const bootstrapSource = readFileSync(hostedBootstrapPath, "utf8");
    const driverSource = readFileSync(hostedDriverPath, "utf8");
    const runtimeSource = readFileSync(hostedRuntimePath, "utf8");
    const backendSource = readFileSync(hostedBackendPath, "utf8");
    const localBackendSource = readFileSync(hostedLocalBackendPath, "utf8");
    const managedSessionSource = readFileSync(managedSessionPath, "utf8");
    const runtimeProjectionStoreSource = readFileSync(runtimeProjectionStorePath, "utf8");
    const hostedAgentEngineSource = readFileSync(hostedAgentEnginePath, "utf8");
    const agentEnginePackageSource = readFileSync(agentEnginePackagePath, "utf8");
    const agentEngineIndexSource = readFileSync(agentEngineIndexPath, "utf8");
    const brewvaAgentEngineSource = readFileSync(brewvaAgentEnginePath, "utf8");
    const providerStreamSource = readFileSync(providerStreamPath, "utf8");
    const hostedAuthStoreSource = readFileSync(hostedAuthStorePath, "utf8");
    const hostedModelRegistrySource = readFileSync(hostedModelRegistryPath, "utf8");
    const createHostedSessionSource = readFileSync(createHostedSessionPath, "utf8");
    const gatewayPackageJsonSource = readFileSync(gatewayPackageJsonPath, "utf8");

    expect(bootstrapSource).toContain("BrewvaManagedPromptSession");
    expect(bootstrapSource).not.toContain('HostedSessionCreateResult["session"]');
    expect(bootstrapSource).not.toContain("createHostedPiResourceLoader");
    expect(bootstrapSource).not.toContain("createHostedPiSession");
    expect(bootstrapSource).not.toContain("adaptRuntimePluginFactories");
    expect(bootstrapSource).not.toContain("pi-runtime-plugin-adapter");
    expect(bootstrapSource).not.toContain("sessionModelRegistry");
    expect(bootstrapSource).not.toContain("authStorage");
    expect(bootstrapSource).not.toContain("resolveBootstrapSelection");
    expect(bootstrapSource).not.toContain(".createServices(");
    expect(bootstrapSource).not.toContain(".createSession(");
    expect(driverSource).toContain("createHostedSessionDriver");
    expect(driverSource).toContain("createRuntime(");
    expect(driverSource).toContain("requestedModel");
    expect(driverSource).toContain("internalRuntimePlugins");
    expect(driverSource).toContain("readonly settings: HostedSessionSettingsView");
    expect(driverSource).toContain("readonly modelCatalog: BrewvaModelCatalog");
    expect(driverSource).not.toContain("HostedSessionResourceLoader");
    expect(driverSource).not.toContain("export type HostedSessionCreateResult");
    expect(driverSource).not.toContain("DefaultResourceLoader");
    expect(driverSource).not.toContain("createAgentSession(");
    expect(driverSource).not.toContain("requirePiSettingsManager");
    expect(driverSource).not.toContain("@mariozechner/pi-coding-agent");
    expect(driverSource).not.toContain("pi-hosted-session-runtime");
    expect(driverSource).not.toContain("createPiHostedSessionDriver");
    expect(driverSource).not.toContain("createPiHostedSettingsManager");
    expect(driverSource).not.toContain("requirePiHostedSessionBridge");

    expect(runtimeSource).toContain("createHostedSessionRuntimeDriver");
    expect(runtimeSource).toContain("createHostedSessionRuntimeSettings");
    expect(runtimeSource).not.toContain("requireHostedSessionPiBridge");
    expect(runtimeSource).not.toContain("HostedPiSessionBridge");
    expect(runtimeSource).not.toContain("@mariozechner/pi-coding-agent");
    expect(runtimeSource).not.toContain("pi-hosted-session-runtime");
    expect(runtimeSource).not.toContain("createPiHostedSessionDriver");
    expect(runtimeSource).not.toContain("createPiHostedSettingsManager");
    expect(runtimeSource).toContain("createHostedSessionModelServices");
    expect(runtimeSource).toContain("createHostedSessionServicesBundle");
    expect(runtimeSource).toContain("createHostedSessionResult");

    expect(backendSource).toContain("createHostedSessionSettingsHandle");
    expect(backendSource).toContain("createHostedSessionModelServices");
    expect(backendSource).toContain("createHostedSessionServicesBundle");
    expect(backendSource).toContain("createHostedSessionResult");
    expect(backendSource).not.toContain("AuthStorage.create(");
    expect(backendSource).not.toContain("ModelRegistry.create(");
    expect(backendSource).not.toContain("@mariozechner/pi-coding-agent");
    expect(backendSource).not.toContain("createAgentSession(");
    expect(backendSource).not.toContain("DefaultResourceLoader");
    expect(backendSource).not.toContain("pi-hosted-session-backend");
    expect(backendSource).not.toContain("createPiHostedSessionBackendAdapter");

    expect(localBackendSource).toContain("createHostedResourceLoader");
    expect(localBackendSource).toContain("createBrewvaManagedAgentSession");
    expect(localBackendSource).toContain("HostedRuntimeTapeSessionStore");
    expect(localBackendSource).not.toContain("HostedRuntimeProjectionSessionStore");
    expect(localBackendSource).toContain(
      "createHostedModelServices as createLocalHostedModelServices",
    );
    expect(localBackendSource).toContain("readHostedSettingsHandle");
    expect(localBackendSource).not.toContain("DefaultResourceLoader");
    expect(localBackendSource).not.toContain("SessionManager");
    expect(localBackendSource).not.toContain("new BrewvaManagedSessionStore");
    expect(localBackendSource).not.toContain("createAgentSession(");
    expect(localBackendSource).not.toContain("new AgentSession(");
    expect(localBackendSource).not.toContain("@mariozechner/pi-coding-agent");
    expect(localBackendSource).not.toContain("AuthStorage.create(");
    expect(localBackendSource).not.toContain("ModelRegistry.create(");
    expect(runtimeProjectionStoreSource).not.toContain("hosted_session_projection_");
    expect(runtimeProjectionStoreSource).toContain("migrateLegacyHostedProjectionEvents");

    expect(managedSessionSource).toContain("createHostedAgentEngine");
    expect(managedSessionSource).toContain("previewCompaction");
    expect(managedSessionSource).not.toContain("appendCompaction(");
    expect(managedSessionSource).not.toContain("createHostedPiAgentEngine");
    expect(managedSessionSource).not.toContain("@mariozechner/pi-agent-core");
    expect(managedSessionSource).not.toContain("@mariozechner/pi-ai");
    expect(managedSessionSource).not.toContain("@mariozechner/pi-coding-agent");

    expect(hostedAgentEngineSource).toContain('from "@brewva/brewva-agent-engine"');
    expect(hostedAgentEngineSource).not.toContain("@mariozechner/pi-agent-core");
    expect(hostedAgentEngineSource).not.toContain("@mariozechner/pi-ai");
    expect(hostedAgentEngineSource).not.toContain("@mariozechner/pi-coding-agent");

    expect(agentEngineIndexSource).toContain('from "./brewva-agent-engine.js"');
    expect(agentEnginePackageSource).not.toContain('"@mariozechner/pi-agent-core"');
    expect(agentEnginePackageSource).not.toContain('"@mariozechner/pi-ai"');
    expect(agentEnginePackageSource).toContain('"@brewva/brewva-provider-core"');
    expect(agentEnginePackageSource).toContain('"ajv"');
    expect(agentEnginePackageSource).toContain('"ajv-formats"');
    expect(agentEnginePackageSource).toContain('"@sinclair/typebox"');

    expect(hostedAuthStoreSource).not.toContain("@mariozechner/pi-ai");
    expect(hostedModelRegistrySource).not.toContain("@mariozechner/pi-ai");

    expect(brewvaAgentEngineSource).not.toContain("@mariozechner/pi-agent-core");
    expect(brewvaAgentEngineSource).not.toContain("@mariozechner/pi-ai");
    expect(brewvaAgentEngineSource).not.toContain("@mariozechner/pi-coding-agent");
    expect(providerStreamSource).not.toContain("@mariozechner/pi-agent-core");
    expect(providerStreamSource).not.toContain("@mariozechner/pi-ai");
    expect(providerStreamSource).not.toContain("@mariozechner/pi-coding-agent");
    expect(providerStreamSource).toContain("@brewva/brewva-provider-core");
    expect(providerStreamSource).not.toContain("as unknown as ProviderModel");
    expect(providerStreamSource).not.toContain("as unknown as ProviderContext");
    expect(providerStreamSource).not.toContain("as unknown as ProviderAssistantMessageEventStream");

    expect(createHostedSessionSource).not.toContain("requireHostedPiSession");
    expect(createHostedSessionSource).not.toContain("HostedPiSessionBridge");
    expect(gatewayPackageJsonSource).not.toContain('"@mariozechner/pi-coding-agent"');
    expect(gatewayPackageJsonSource).not.toContain('"@mariozechner/pi-ai"');
    expect(gatewayPackageJsonSource).not.toContain('"@mariozechner/pi-agent-core"');
  });
});
