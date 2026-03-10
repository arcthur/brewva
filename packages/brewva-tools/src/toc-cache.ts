import { readFileSync } from "node:fs";
import type { BrewvaToolRuntime } from "./types.js";

const MAX_CACHE_SESSIONS = 64;
const MAX_CACHE_ENTRIES_PER_SESSION = 512;

interface SourceCacheEntry {
  signature: string;
  sourceText: string;
  lines: string[];
}

type SourceSessionCacheStore = Map<string, Map<string, SourceCacheEntry>>;

const sourceCacheStore: SourceSessionCacheStore = new Map();
const attachedRuntimes = new WeakSet<object>();

function getSessionCache(
  cacheStore: SourceSessionCacheStore,
  sessionKey: string,
): Map<string, SourceCacheEntry> {
  const existing = cacheStore.get(sessionKey);
  if (existing) {
    cacheStore.delete(sessionKey);
    cacheStore.set(sessionKey, existing);
    return existing;
  }

  const created = new Map<string, SourceCacheEntry>();
  cacheStore.set(sessionKey, created);
  while (cacheStore.size > MAX_CACHE_SESSIONS) {
    const oldest = cacheStore.keys().next().value;
    if (!oldest) break;
    cacheStore.delete(oldest);
  }
  return created;
}

export function resolveTocSessionKey(sessionId: string | undefined): string {
  return sessionId && sessionId.length > 0 ? sessionId : "__anonymous__";
}

export function registerTocSourceCacheRuntime(runtime?: BrewvaToolRuntime): void {
  if (!runtime?.session?.onClearState) return;
  if (attachedRuntimes.has(runtime as object)) return;
  runtime.session.onClearState((sessionId) => {
    sourceCacheStore.delete(resolveTocSessionKey(sessionId));
  });
  attachedRuntimes.add(runtime as object);
}

export function readSourceTextWithCache(input: {
  sessionId?: string;
  absolutePath: string;
  signature: string;
}): {
  sourceText: string;
  lines: string[];
  cacheHit: boolean;
} {
  const cache = getSessionCache(sourceCacheStore, resolveTocSessionKey(input.sessionId));
  const cached = cache.get(input.absolutePath);
  if (cached && cached.signature === input.signature) {
    cache.delete(input.absolutePath);
    cache.set(input.absolutePath, cached);
    return {
      sourceText: cached.sourceText,
      lines: cached.lines,
      cacheHit: true,
    };
  }

  const sourceText = readFileSync(input.absolutePath, "utf8");
  const entry: SourceCacheEntry = {
    signature: input.signature,
    sourceText,
    lines: sourceText.split("\n"),
  };
  cache.set(input.absolutePath, entry);
  while (cache.size > MAX_CACHE_ENTRIES_PER_SESSION) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
  return {
    sourceText: entry.sourceText,
    lines: entry.lines,
    cacheHit: false,
  };
}
