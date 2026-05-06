export type DuckDBModule = typeof import("@duckdb/node-api");
export type DuckDBConnection = import("@duckdb/node-api").DuckDBConnection;
export type DuckDBInstance = import("@duckdb/node-api").DuckDBInstance;

export interface DuckDBInstanceHandle {
  instance: DuckDBInstance;
  release(): void;
}

interface CachedDuckDBInstance {
  instance: DuckDBInstance;
  refs: number;
}

const instanceCache = new Map<string, CachedDuckDBInstance>();

export async function acquireDuckDBInstance(
  duckdb: DuckDBModule,
  dbPath: string,
  readOnly: boolean,
): Promise<DuckDBInstanceHandle> {
  const cacheKey = duckDBInstanceCacheKey(dbPath, readOnly);
  const cached = instanceCache.get(cacheKey);
  if (cached) {
    cached.refs += 1;
    return {
      instance: cached.instance,
      release: () => releaseDuckDBInstance(cacheKey),
    };
  }

  const instance = await duckdb.DuckDBInstance.create(
    dbPath,
    readOnly ? { access_mode: "READ_ONLY" } : undefined,
  );
  instanceCache.set(cacheKey, {
    instance,
    refs: 1,
  });
  return {
    instance,
    release: () => releaseDuckDBInstance(cacheKey),
  };
}

function duckDBInstanceCacheKey(dbPath: string, readOnly: boolean): string {
  return `${readOnly ? "ro" : "rw"}:${dbPath}`;
}

function releaseDuckDBInstance(cacheKey: string): void {
  const cached = instanceCache.get(cacheKey);
  if (!cached) return;
  cached.refs -= 1;
  if (cached.refs > 0) return;
  instanceCache.delete(cacheKey);
  try {
    cached.instance.closeSync();
  } catch {}
}
