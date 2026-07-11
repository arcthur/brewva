import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrewvaConfig } from "@brewva/brewva-runtime";
import { parseJsonc } from "@brewva/brewva-runtime/config";
import { createSingleFlight } from "@brewva/brewva-std/async";
import { isRecord, toErrorMessage } from "@brewva/brewva-std/unknown";
import { normalizeAgentId } from "@brewva/brewva-vocabulary/session";
import { createHostedRuntimeAdapter } from "../hosted/api.js";
import type { HostedRuntimeAdapterPort } from "../hosted/api.js";

export interface AgentRuntimeHandle {
  agentId: string;
  runtime: HostedRuntimeAdapterPort;
  createdAt: number;
  lastUsedAt: number;
  sessionRefs: number;
}

export interface AgentRuntimeSummary {
  agentId: string;
  createdAt: number;
  lastUsedAt: number;
  sessionRefs: number;
}

export interface AgentRuntimeManagerOptions {
  controllerRuntime: HostedRuntimeAdapterPort;
  maxLiveRuntimes: number;
  idleRuntimeTtlMs: number;
}

function deepMerge(base: unknown, overlay: unknown): unknown {
  if (!isRecord(base) || !isRecord(overlay)) {
    return overlay === undefined ? base : overlay;
  }
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = output[key];
    if (isRecord(existing) && isRecord(value)) {
      output[key] = deepMerge(existing, value);
      continue;
    }
    output[key] = value;
  }
  return output;
}

function forceNamespaceConfig(baseConfig: BrewvaConfig, agentId: string): BrewvaConfig {
  const stateRoot = `.brewva/agents/${agentId}/state`;
  return {
    ...baseConfig,
    ledger: {
      ...baseConfig.ledger,
      path: `${stateRoot}/ledger/evidence.jsonl`,
    },
    projection: {
      ...baseConfig.projection,
      dir: `${stateRoot}/projection`,
    },
    tape: {
      ...baseConfig.tape,
      dir: `${stateRoot}/tape`,
    },
    worlds: {
      ...baseConfig.worlds,
      dir: `${stateRoot}/worlds`,
    },
    schedule: {
      ...baseConfig.schedule,
      enabled: false,
      projectionPath: `${stateRoot}/schedule/intents.jsonl`,
    },
    infrastructure: {
      ...baseConfig.infrastructure,
      recoveryWal: {
        ...baseConfig.infrastructure.recoveryWal,
        dir: `${stateRoot}/recovery-wal`,
      },
    },
  };
}

async function loadAgentConfigOverlay(workspaceRoot: string, agentId: string): Promise<unknown> {
  const path = resolve(workspaceRoot, ".brewva", "agents", agentId, "config.json");
  if (!existsSync(path)) return {};
  const raw = await readFile(path, "utf8");
  if (!raw.trim()) return {};
  try {
    const parsed = parseJsonc(raw);
    if (!isRecord(parsed)) {
      throw new Error("root must be an object");
    }
    return parsed;
  } catch (error) {
    throw new Error(`invalid_agent_config:${agentId}:${toErrorMessage(error)}`, { cause: error });
  }
}

export class AgentRuntimeManager {
  readonly workspaceRoot: string;
  readonly maxLiveRuntimes: number;
  readonly idleRuntimeTtlMs: number;

  private readonly controllerRuntime: HostedRuntimeAdapterPort;
  private readonly handles = new Map<string, AgentRuntimeHandle>();
  private readonly creating = createSingleFlight<string, AgentRuntimeHandle>();

  constructor(options: AgentRuntimeManagerOptions) {
    this.controllerRuntime = options.controllerRuntime;
    this.workspaceRoot = options.controllerRuntime.identity.workspaceRoot;
    this.maxLiveRuntimes = Math.max(1, Math.floor(options.maxLiveRuntimes));
    this.idleRuntimeTtlMs = Math.max(1, Math.floor(options.idleRuntimeTtlMs));
  }

  listRuntimes(): AgentRuntimeSummary[] {
    return [...this.handles.values()]
      .map((entry) => ({
        agentId: entry.agentId,
        createdAt: entry.createdAt,
        lastUsedAt: entry.lastUsedAt,
        sessionRefs: entry.sessionRefs,
      }))
      .toSorted((a, b) => b.lastUsedAt - a.lastUsedAt || a.agentId.localeCompare(b.agentId));
  }

  async createInspectionRuntime(requestedAgentId: string): Promise<HostedRuntimeAdapterPort> {
    const agentId = normalizeAgentId(requestedAgentId);
    const existing = this.handles.get(agentId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.runtime;
    }
    return this.buildRuntime(agentId);
  }

  async getOrCreateRuntime(requestedAgentId: string): Promise<HostedRuntimeAdapterPort> {
    const agentId = normalizeAgentId(requestedAgentId);
    const existing = this.handles.get(agentId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.runtime;
    }

    // Coalesce concurrent creations of the same agent onto one in-flight build;
    // the resolved handle is cached in `handles` (checked above), so this only
    // de-dupes the creation, it does not memoize inside the single-flight.
    const handle = await this.creating.run(agentId, async () => {
      const created = await this.createRuntime(agentId);
      this.handles.set(agentId, created);
      return created;
    });
    handle.lastUsedAt = Date.now();
    return handle.runtime;
  }

  retainRuntime(requestedAgentId: string): void {
    const agentId = normalizeAgentId(requestedAgentId);
    const handle = this.handles.get(agentId);
    if (!handle) return;
    handle.sessionRefs += 1;
    handle.lastUsedAt = Date.now();
  }

  releaseRuntime(requestedAgentId: string): void {
    const agentId = normalizeAgentId(requestedAgentId);
    const handle = this.handles.get(agentId);
    if (!handle) return;
    handle.sessionRefs = Math.max(0, handle.sessionRefs - 1);
    handle.lastUsedAt = Date.now();
  }

  touchRuntime(requestedAgentId: string): void {
    const agentId = normalizeAgentId(requestedAgentId);
    const handle = this.handles.get(agentId);
    if (!handle) return;
    handle.lastUsedAt = Date.now();
  }

  evictIdleRuntimes(now = Date.now()): string[] {
    const evicted: string[] = [];
    for (const handle of Array.from(this.handles.values())) {
      if (handle.sessionRefs > 0) continue;
      if (now - handle.lastUsedAt < this.idleRuntimeTtlMs) continue;
      this.disposeHandle(handle);
      evicted.push(handle.agentId);
    }
    return evicted;
  }

  disposeRuntime(requestedAgentId: string): boolean {
    const agentId = normalizeAgentId(requestedAgentId);
    const handle = this.handles.get(agentId);
    if (!handle) return false;
    this.disposeHandle(handle);
    return true;
  }

  disposeAll(): void {
    for (const handle of Array.from(this.handles.values())) {
      this.disposeHandle(handle);
    }
  }

  private async createRuntime(agentId: string): Promise<AgentRuntimeHandle> {
    this.evictIdleRuntimes(Date.now());
    this.enforceCapacity();
    const runtime = await this.buildRuntime(agentId);
    const now = Date.now();
    return {
      agentId,
      runtime,
      createdAt: now,
      lastUsedAt: now,
      sessionRefs: 0,
    };
  }

  private async buildRuntime(agentId: string): Promise<HostedRuntimeAdapterPort> {
    const baseConfig = structuredClone(this.controllerRuntime.config);
    const overlay = await loadAgentConfigOverlay(this.workspaceRoot, agentId);
    const merged = deepMerge(baseConfig, overlay) as BrewvaConfig;
    const config = forceNamespaceConfig(merged, agentId);
    return createHostedRuntimeAdapter({
      cwd: this.controllerRuntime.identity.cwd,
      agentId,
      config,
    });
  }

  private enforceCapacity(): void {
    if (this.handles.size < this.maxLiveRuntimes) return;

    const candidates = [...this.handles.values()]
      .filter((entry) => entry.sessionRefs === 0)
      .toSorted((a, b) => a.lastUsedAt - b.lastUsedAt);
    while (this.handles.size >= this.maxLiveRuntimes && candidates.length > 0) {
      const candidate = candidates.shift();
      if (!candidate) break;
      this.disposeHandle(candidate);
    }

    if (this.handles.size >= this.maxLiveRuntimes) {
      throw new Error("runtime_capacity_exhausted");
    }
  }

  private disposeHandle(handle: AgentRuntimeHandle): void {
    this.handles.delete(handle.agentId);
  }
}
