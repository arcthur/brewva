import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ModelCapabilityRegistry } from "./contracts.js";

export interface HostedProviderSessionBinding {
  runtime: BrewvaRuntime;
  registry: ModelCapabilityRegistry;
  lastProfileFingerprint?: string;
}

const hostedProviderSessionBindings = new Map<string, HostedProviderSessionBinding>();

export function getHostedProviderSessionBinding(
  sessionId: string | undefined,
): HostedProviderSessionBinding | undefined {
  return sessionId ? hostedProviderSessionBindings.get(sessionId) : undefined;
}

export function registerHostedProviderSessionBinding(input: {
  sessionId: string;
  binding: HostedProviderSessionBinding;
}): void {
  hostedProviderSessionBindings.set(input.sessionId, input.binding);
}

export function releaseHostedProviderSessionBinding(sessionId: string): void {
  hostedProviderSessionBindings.delete(sessionId);
}
