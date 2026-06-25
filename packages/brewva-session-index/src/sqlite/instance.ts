import type { Database } from "bun:sqlite";
import { createRequire } from "node:module";

/** The engine-agnostic connection handle the projection/query layers operate on. */
export type SqliteConnection = Database;

export interface SqliteInstanceHandle {
  connection: Database;
  release(): void;
}

interface CachedSqlite {
  db: Database;
  refs: number;
}

const instanceCache = new Map<string, CachedSqlite>();

// `bun:sqlite` is a Bun-only builtin. A top-level VALUE import would make the
// whole session-index import graph unloadable under Node
// (ERR_UNSUPPORTED_ESM_URL_SCHEME), breaking the Node-based dist import-graph
// verification and the `node CLI --help` smoke (script/verify-dist.ts) — both
// deliberately load the dist under Node to check export shape, exactly as
// `@brewva/brewva-cli/internal-shell-runtime` keeps a Node-safe stub. So the type
// import stays erasable (`import type`) and the VALUE import is deferred to the
// first real database open, which only ever runs on the Bun runtime. The import
// graph stays Node-loadable; the runtime stays Bun-bound at the SQLite I/O edge.
const requireBunBuiltin = createRequire(import.meta.url);
let cachedDatabaseCtor: typeof Database | undefined;
function getDatabaseCtor(): typeof Database {
  cachedDatabaseCtor ??= (requireBunBuiltin("bun:sqlite") as typeof import("bun:sqlite")).Database;
  return cachedDatabaseCtor;
}

/**
 * Open (or reuse) a bun:sqlite database. One writer process opens read-write and
 * establishes WAL; non-writer processes open read-only and read the live WAL
 * (snapshot isolation) — no physical snapshot copy is involved.
 */
export function acquireSqliteInstance(dbPath: string, readOnly: boolean): SqliteInstanceHandle {
  const cacheKey = `${readOnly ? "ro" : "rw"}:${dbPath}`;
  const cached = instanceCache.get(cacheKey);
  if (cached) {
    cached.refs += 1;
    return { connection: cached.db, release: () => releaseSqliteInstance(cacheKey) };
  }

  const DatabaseCtor = getDatabaseCtor();
  const db = new DatabaseCtor(
    dbPath,
    readOnly ? { readonly: true } : { create: true, readwrite: true },
  );
  if (readOnly) {
    // A read-only handle inherits the WAL journal the writer established and only
    // needs a busy timeout. It still requires a writable directory for the
    // -wal/-shm sidecars, so immutable=1 is deliberately NOT used.
    db.exec("PRAGMA busy_timeout = 5000");
  } else {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA wal_autocheckpoint = 1000");
  }

  instanceCache.set(cacheKey, { db, refs: 1 });
  return { connection: db, release: () => releaseSqliteInstance(cacheKey) };
}

function releaseSqliteInstance(cacheKey: string): void {
  const cached = instanceCache.get(cacheKey);
  if (!cached) return;
  cached.refs -= 1;
  if (cached.refs > 0) return;
  instanceCache.delete(cacheKey);
  try {
    cached.db.close();
  } catch {}
}
