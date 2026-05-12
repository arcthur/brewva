import type {
  InternalHostPluginApi,
  RuntimePluginCapability,
} from "@brewva/brewva-substrate/host-api";
import { defineInternalHostPlugin as defineSubstrateHostPlugin } from "@brewva/brewva-substrate/host-api";

export interface HostedExtensionApi extends InternalHostPluginApi {}

export interface HostedExtensionPlugin {
  readonly name: string;
  readonly capabilities: readonly HostedExtensionCapability[];
  register(api: HostedExtensionApi): void | Promise<void>;
}

export type HostedExtensionCapability = RuntimePluginCapability;

export function defineHostedExtensionPlugin(plugin: HostedExtensionPlugin): HostedExtensionPlugin {
  return defineSubstrateHostPlugin(plugin);
}

export type {
  LocalHookNote,
  LocalHookPhase,
  LocalHookPort,
  LocalHookPostReceiptInput,
  LocalHookPostReceiptResult,
  LocalHookPostRollbackInput,
  LocalHookPostRollbackResult,
  LocalHookPostTerminalInput,
  LocalHookPostTerminalResult,
  LocalHookPreAdmissionInput,
  LocalHookPreAdmissionResult,
  LocalHookPreEffectInput,
  LocalHookPreEffectResult,
  LocalHookRecommendation,
  LocalHookResult,
} from "../hosted/internal/thread-loop/lifecycle/local-hook-port.js";
