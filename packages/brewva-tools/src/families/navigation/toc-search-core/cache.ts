import { LRUCache } from "lru-cache";
import { getOrCreateLruValue } from "../../../utils/lru.js";
import { MAX_CACHE_ENTRIES_PER_SESSION, MAX_CACHE_SESSIONS } from "./constants.js";
import { parseTocDocument } from "./document.js";
import type { TocFileCache, TocLookupResult, TocSearchSessionCacheStore } from "./types.js";

function getSessionCache(cacheStore: TocSearchSessionCacheStore, sessionKey: string): TocFileCache {
  return getOrCreateLruValue(cacheStore, sessionKey, () => {
    return new LRUCache({
      max: MAX_CACHE_ENTRIES_PER_SESSION,
    });
  });
}

export function createTocSearchSessionCacheStore(): TocSearchSessionCacheStore {
  return new LRUCache({
    max: MAX_CACHE_SESSIONS,
  });
}

export function lookupTocDocument(input: {
  cacheStore: TocSearchSessionCacheStore;
  sessionKey: string;
  absolutePath: string;
  signature: string;
  sourceText: string;
}): TocLookupResult {
  const cache = getSessionCache(input.cacheStore, input.sessionKey);
  const cached = cache.get(input.absolutePath);
  if (cached && cached.signature === input.signature) {
    return {
      toc: cached.toc,
      cacheHit: true,
    };
  }

  const toc = parseTocDocument(input.absolutePath, input.sourceText);
  cache.set(input.absolutePath, {
    signature: input.signature,
    toc,
  });
  return {
    toc,
    cacheHit: false,
  };
}
