import { LRUCache } from "lru-cache";

export function getOrCreateLruValue<K extends {}, V extends {}>(
  cache: LRUCache<K, V>,
  key: K,
  create: () => V,
): V {
  const existing = cache.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created = create();
  cache.set(key, created);
  return created;
}
