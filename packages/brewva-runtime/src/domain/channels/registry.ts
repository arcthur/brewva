import type { ChannelAdapter } from "./adapter.js";
import { normalizeChannelId } from "./channel-id.js";

export interface AdapterRegistration {
  id: string;
  create: () => ChannelAdapter;
}

interface RegistryEntry {
  id: string;
  create: () => ChannelAdapter;
}

function normalizeToken(value: string): string {
  return normalizeChannelId(value);
}

export class ChannelAdapterRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  register(input: AdapterRegistration): string {
    const id = normalizeToken(input.id);
    if (!id) {
      throw new Error("adapter id is required");
    }
    if (this.entries.has(id)) {
      throw new Error(`adapter already registered: ${id}`);
    }

    this.entries.set(id, { id, create: input.create });
    return id;
  }

  unregister(idOrAlias: string): boolean {
    const id = normalizeToken(idOrAlias);
    if (!id) {
      return false;
    }
    return this.entries.delete(id);
  }

  resolveId(idOrAlias: string): string | undefined {
    const normalized = normalizeToken(idOrAlias);
    if (!normalized) {
      return undefined;
    }
    return this.entries.has(normalized) ? normalized : undefined;
  }

  createAdapter(idOrAlias: string): ChannelAdapter | undefined {
    const id = this.resolveId(idOrAlias);
    if (!id) {
      return undefined;
    }
    const entry = this.entries.get(id);
    if (!entry) {
      return undefined;
    }
    const adapter = entry.create();
    const adapterId = normalizeToken(adapter.id);
    if (adapterId !== id) {
      throw new Error(`adapter id mismatch: expected ${id}, got ${adapter.id}`);
    }
    return adapter;
  }

  list(): Array<{ id: string }> {
    return Array.from(this.entries.values())
      .map((entry) => ({ id: entry.id }))
      .toSorted((a, b) => a.id.localeCompare(b.id));
  }
}
