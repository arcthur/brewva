import { readFileSync } from "node:fs";
import { LRUCache } from "lru-cache";
import type { BrewvaToolRuntime } from "./types.js";
import { getOrCreateLruValue } from "./utils/lru.js";

const MAX_CACHE_SESSIONS = 64;
const MAX_CACHE_ENTRIES_PER_SESSION = 512;

interface SourceCacheEntry {
  signature: string;
  sourceText: string;
  lines: string[];
}

type SourceFileCache = LRUCache<string, SourceCacheEntry>;
type SourceSessionCacheStore = LRUCache<string, SourceFileCache>;

const sourceCacheStore: SourceSessionCacheStore = new LRUCache({
  max: MAX_CACHE_SESSIONS,
});
const attachedRuntimes = new WeakSet<object>();

function getSessionCache(cacheStore: SourceSessionCacheStore, sessionKey: string): SourceFileCache {
  return getOrCreateLruValue(cacheStore, sessionKey, () => {
    return new LRUCache({
      max: MAX_CACHE_ENTRIES_PER_SESSION,
    });
  });
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
  return {
    sourceText: entry.sourceText,
    lines: entry.lines,
    cacheHit: false,
  };
}
