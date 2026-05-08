import { readFileSync, statSync } from "node:fs";
import { LRUCache } from "lru-cache";
import { MAX_ARTIFACT_CACHE_BYTES, MAX_ARTIFACT_CACHE_ENTRIES } from "./constants.js";
import { prepareArtifact } from "./search-engine.js";
import type { ArtifactCacheEntry, ArtifactLoadStats, PreparedArtifact } from "./types.js";

const artifactCache = new LRUCache<string, ArtifactCacheEntry>({
  max: MAX_ARTIFACT_CACHE_ENTRIES,
  maxSize: MAX_ARTIFACT_CACHE_BYTES,
  sizeCalculation: (entry) => entry.estimatedBytes,
});

function buildArtifactCacheKey(cacheScope: string, absolutePath: string): string {
  return `${cacheScope}::${absolutePath}`;
}

function estimateCacheEntryBytes(rawBytes: number): number {
  return Math.max(rawBytes, rawBytes * 4);
}

export function getPreparedArtifact(input: {
  cacheScope: string;
  absolutePath: string;
  maxArtifactBytes: number;
  localCache: Map<string, PreparedArtifact>;
  skippedLargePaths: Set<string>;
  readFailurePaths: Set<string>;
  stats: ArtifactLoadStats;
}): PreparedArtifact | undefined {
  const local = input.localCache.get(input.absolutePath);
  if (local) {
    input.stats.cacheHits += 1;
    input.stats.localCacheHits += 1;
    return local;
  }

  try {
    const fileStat = statSync(input.absolutePath);
    if (fileStat.size > input.maxArtifactBytes) {
      input.skippedLargePaths.add(input.absolutePath);
      return undefined;
    }

    const cacheKey = buildArtifactCacheKey(input.cacheScope, input.absolutePath);
    const cached = artifactCache.get(cacheKey);
    if (cached && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) {
      input.localCache.set(input.absolutePath, cached.prepared);
      input.stats.cacheHits += 1;
      input.stats.globalCacheHits += 1;
      return cached.prepared;
    }

    const content = readFileSync(input.absolutePath, "utf8");
    const prepared = prepareArtifact(content);
    artifactCache.set(cacheKey, {
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      estimatedBytes: estimateCacheEntryBytes(Buffer.byteLength(content, "utf8")),
      prepared,
    });
    input.localCache.set(input.absolutePath, prepared);
    input.stats.cacheMisses += 1;
    return prepared;
  } catch {
    input.readFailurePaths.add(input.absolutePath);
    return undefined;
  }
}
