import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("gateway contract: hosted session surface", () => {
  test("anchors the exported HostedSession type on substrate-owned prompt-session contracts", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const hostedBootstrapPath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "hosted",
      "internal",
      "session",
      "init",
      "session-assembly.ts",
    );
    const hostedFactoryPath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "hosted",
      "internal",
      "session",
      "session-factory.ts",
    );
    const hostedRuntimePath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "hosted",
      "internal",
      "session",
      "session-runtime.ts",
    );
    const hostedServicesPath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "hosted",
      "internal",
      "session",
      "local-session-services.ts",
    );
    const hostedLocalServicesPath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "hosted",
      "internal",
      "session",
      "local-session-services.ts",
    );
    const managedSessionPath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "hosted",
      "internal",
      "session",
      "managed-agent",
      "session.ts",
    );
    const runtimeProjectionStorePath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "hosted",
      "internal",
      "session",
      "projection",
      "runtime-projection-session-store.ts",
    );
    const substratePackagePath = resolve(repoRoot, "packages", "brewva-substrate", "package.json");
    const turnIndexPath = resolve(
      repoRoot,
      "packages",
      "brewva-substrate",
      "src",
      "turn",
      "index.ts",
    );
    const turnControllerPath = resolve(
      repoRoot,
      "packages",
      "brewva-substrate",
      "src",
      "turn",
      "controller.ts",
    );
    const providerStreamPath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "hosted",
      "internal",
      "provider",
      "stream.ts",
    );
    const hostedAuthStorePath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "hosted",
      "internal",
      "session",
      "settings",
      "hosted-auth-store.ts",
    );
    const hostedModelRegistryPath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "hosted",
      "internal",
      "session",
      "settings",
      "hosted-model-registry.ts",
    );
    const createHostedSessionPath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "hosted",
      "internal",
      "session",
      "create-hosted-session.ts",
    );
    const gatewayPackageJsonPath = resolve(repoRoot, "packages", "brewva-gateway", "package.json");

    const bootstrapSource = readFileSync(hostedBootstrapPath, "utf8");
    const factorySource = readFileSync(hostedFactoryPath, "utf8");
    const runtimeSource = readFileSync(hostedRuntimePath, "utf8");
    const servicesSource = readFileSync(hostedServicesPath, "utf8");
    const localServicesSource = readFileSync(hostedLocalServicesPath, "utf8");
    const managedSessionSource = readFileSync(managedSessionPath, "utf8");
    const runtimeProjectionStoreSource = readFileSync(runtimeProjectionStorePath, "utf8");
    const substratePackageSource = readFileSync(substratePackagePath, "utf8");
    const turnIndexSource = readFileSync(turnIndexPath, "utf8");
    const turnControllerSource = readFileSync(turnControllerPath, "utf8");
    const providerStreamSource = readFileSync(providerStreamPath, "utf8");
    const hostedAuthStoreSource = readFileSync(hostedAuthStorePath, "utf8");
    const hostedModelRegistrySource = readFileSync(hostedModelRegistryPath, "utf8");
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
    expect(factorySource).toContain("createHostedSessionFactory");
    expect(factorySource).toContain("createRuntime(");
    expect(factorySource).toContain("requestedModel");
    expect(factorySource).toContain("extensions");
    expect(factorySource).toContain("readonly settings: HostedSessionSettingsView");
    expect(factorySource).toContain("readonly modelCatalog: BrewvaModelCatalog");
    expect(factorySource).not.toContain("HostedSessionResourceLoader");
    expect(factorySource).not.toContain("export type HostedSessionCreateResult");
    expect(factorySource).not.toContain("DefaultResourceLoader");
    expect(factorySource).not.toContain("createAgentSession(");
    expect(factorySource).not.toContain("requirePiSettingsManager");
    expect(factorySource).not.toContain("@mariozechner/pi-coding-agent");
    expect(factorySource).not.toContain("pi-session-runtime");
    expect(factorySource).not.toContain("createPiHostedSessionFactory");
    expect(factorySource).not.toContain("createPiHostedSettingsManager");
    expect(factorySource).not.toContain("requirePiHostedSessionBridge");

    expect(runtimeSource).toContain("createHostedSessionRuntimeFactory");
    expect(runtimeSource).toContain("createHostedSessionRuntimeSettings");
    expect(runtimeSource).not.toContain("requireHostedSessionPiBridge");
    expect(runtimeSource).not.toContain("HostedPiSessionBridge");
    expect(runtimeSource).not.toContain("@mariozechner/pi-coding-agent");
    expect(runtimeSource).not.toContain("pi-session-runtime");
    expect(runtimeSource).not.toContain("createPiHostedSessionFactory");
    expect(runtimeSource).not.toContain("createPiHostedSettingsManager");
    expect(runtimeSource).toContain("createHostedSessionModelServices");
    expect(runtimeSource).toContain("createHostedSessionServicesBundle");
    expect(runtimeSource).toContain("createHostedSessionResult");

    expect(servicesSource).toContain("createHostedSessionSettingsHandle");
    expect(servicesSource).toContain("createHostedSessionModelServices");
    expect(servicesSource).toContain("createHostedSessionServicesBundle");
    expect(servicesSource).toContain("createHostedSessionResult");
    expect(servicesSource).not.toContain("AuthStorage.create(");
    expect(servicesSource).not.toContain("ModelRegistry.create(");
    expect(servicesSource).not.toContain("@mariozechner/pi-coding-agent");
    expect(servicesSource).not.toContain("createAgentSession(");
    expect(servicesSource).not.toContain("DefaultResourceLoader");
    expect(servicesSource).not.toContain("pi-hosted-session-backend");
    expect(servicesSource).not.toContain("createPiHostedSessionBackendAdapter");

    expect(localServicesSource).toContain("createHostedResourceLoader");
    expect(localServicesSource).toContain("createBrewvaManagedAgentSession");
    expect(localServicesSource).toContain("HostedRuntimeTapeSessionStore");
    expect(localServicesSource).not.toContain("HostedRuntimeProjectionSessionStore");
    expect(localServicesSource).toContain(
      "createHostedModelServices as createLocalHostedModelServices",
    );
    expect(localServicesSource).toContain("readHostedSettingsHandle");
    expect(localServicesSource).not.toContain("DefaultResourceLoader");
    expect(localServicesSource).not.toContain("SessionManager");
    expect(localServicesSource).not.toContain("new BrewvaManagedSessionStore");
    expect(localServicesSource).not.toContain("createAgentSession(");
    expect(localServicesSource).not.toContain("new AgentSession(");
    expect(localServicesSource).not.toContain("@mariozechner/pi-coding-agent");
    expect(localServicesSource).not.toContain("AuthStorage.create(");
    expect(localServicesSource).not.toContain("ModelRegistry.create(");
    expect(runtimeProjectionStoreSource).not.toContain("hosted_session_projection_");
    expect(runtimeProjectionStoreSource).not.toContain("migrateLegacyHostedProjectionEvents");

    expect(managedSessionSource).toContain("createBrewvaTurnLoopController");
    expect(managedSessionSource).toContain("@brewva/brewva-substrate/turn");
    expect(managedSessionSource).not.toContain("@brewva/brewva-agent-engine");
    expect(managedSessionSource).not.toContain("createHostedAgentEngine");
    expect(managedSessionSource).toContain("previewCompaction");
    expect(managedSessionSource).not.toContain("appendCompaction(");
    expect(managedSessionSource).not.toContain("createHostedPiAgentEngine");
    expect(managedSessionSource).not.toContain("@mariozechner/pi-agent-core");
    expect(managedSessionSource).not.toContain("@mariozechner/pi-ai");
    expect(managedSessionSource).not.toContain("@mariozechner/pi-coding-agent");

    expect(turnIndexSource).toContain("createBrewvaTurnLoopController");
    expect(turnIndexSource).toContain("runBrewvaTurnLoop");
    expect(turnIndexSource).toContain("BrewvaTurnLoopController");
    expect(turnIndexSource).not.toContain("BrewvaAgentEngine");
    expect(turnControllerSource).not.toContain("createBrewvaTurnProviderStreamFunction");
    expect(managedSessionSource).toContain("createHostedProviderStreamFunction");
    expect(turnControllerSource).not.toContain("@mariozechner/pi-agent-core");
    expect(turnControllerSource).not.toContain("@mariozechner/pi-ai");
    expect(turnControllerSource).not.toContain("@mariozechner/pi-coding-agent");
    expect(turnControllerSource).not.toContain("BrewvaAgentEngine");
    for (const subpath of [
      '"./contracts"',
      '"./session"',
      '"./prompt"',
      '"./resources"',
      '"./tools"',
      '"./host-api"',
      '"./persistence"',
      '"./provider"',
      '"./turn"',
    ]) {
      expect(substratePackageSource).toContain(subpath);
    }
    expect(substratePackageSource).toContain('"./turn"');
    expect(substratePackageSource).toContain('"@brewva/brewva-provider-core"');
    expect(substratePackageSource).toContain('"ajv"');
    expect(substratePackageSource).toContain('"ajv-formats"');
    expect(substratePackageSource).toContain('"@sinclair/typebox"');

    expect(hostedAuthStoreSource).not.toContain("@mariozechner/pi-ai");
    expect(hostedModelRegistrySource).not.toContain("@mariozechner/pi-ai");

    expect(providerStreamSource).not.toContain("@mariozechner/pi-agent-core");
    expect(providerStreamSource).not.toContain("@mariozechner/pi-ai");
    expect(providerStreamSource).not.toContain("@mariozechner/pi-coding-agent");
    expect(providerStreamSource).toContain("@brewva/brewva-provider-core/stream");
    expect(providerStreamSource).toContain("@brewva/brewva-provider-core/contracts");
    expect(providerStreamSource).not.toContain("as unknown as ProviderModel");
    expect(providerStreamSource).not.toContain("as unknown as ProviderContext");
    expect(providerStreamSource).not.toContain("as unknown as ProviderAssistantMessageEventStream");

    expect(existsSync(createHostedSessionPath)).toBe(false);
    expect(gatewayPackageJsonSource).not.toContain('"@mariozechner/pi-coding-agent"');
    expect(gatewayPackageJsonSource).not.toContain('"@mariozechner/pi-ai"');
    expect(gatewayPackageJsonSource).not.toContain('"@mariozechner/pi-agent-core"');
  });
});
