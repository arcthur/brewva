import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { BrewvaMutableModelCatalog } from "@brewva/brewva-substrate";
import type {
  HostedSessionBackendAdapter,
  HostedSessionBackendAuthStore,
  HostedSessionBackendCreateResult,
  HostedSessionBackendModelRegistry,
  HostedSessionModelServices,
  HostedSessionServicesBundle,
} from "./hosted-session-backend-contract.js";
import { createHostedSessionBackendAdapter } from "./hosted-session-backend-local.js";
import type {
  CreateHostedManagedSessionOptions,
  HostedSessionSettings,
} from "./hosted-session-driver.js";

const hostedSessionBackendAdapter: HostedSessionBackendAdapter =
  createHostedSessionBackendAdapter();

export type {
  HostedSessionBackendAuthStore,
  HostedSessionBackendCreateResult,
  HostedSessionBackendModelRegistry,
  HostedSessionModelServices,
  HostedSessionServicesBundle,
};

export function createHostedSessionSettingsHandle(
  cwd: string,
  agentDir: string,
): HostedSessionSettings {
  return hostedSessionBackendAdapter.createSettingsHandle(cwd, agentDir);
}

export function createHostedSessionModelServices(agentDir: string): HostedSessionModelServices {
  return hostedSessionBackendAdapter.createModelServices(agentDir);
}

export async function createHostedSessionServicesBundle(input: {
  agentDir: string;
  cwd: string;
  settings: HostedSessionSettings;
  runtime?: BrewvaRuntime;
  runtimePlugins?: HostedSessionServicesBundle["runtimePlugins"];
}): Promise<HostedSessionServicesBundle> {
  return hostedSessionBackendAdapter.createServicesBundle(input);
}

export async function createHostedSessionResult(input: {
  services: HostedSessionServicesBundle;
  modelRegistry: HostedSessionBackendModelRegistry;
  modelCatalog: BrewvaMutableModelCatalog;
  options: CreateHostedManagedSessionOptions;
}): Promise<HostedSessionBackendCreateResult> {
  return hostedSessionBackendAdapter.createSessionResult(input);
}
