import type { JsonRow } from "../query/port.js";
import type { SqlParams } from "../sql/params.js";
import type { SqliteConnection } from "./instance.js";

export type { JsonRow };

// bun:sqlite is synchronous. These helpers return resolved Promises so the
// projection, query, and lifecycle layers keep the exact async/await shape they
// had under the previous async engine — only the connection type, SQL dialect,
// and token storage change. These helpers assume no overlapping transaction on
// the shared handle; concurrent query callers CAN interleave at these await
// points, so the factory's writer gate (SqliteSessionIndex.catchUp/rebuild)
// serializes every BEGIN-bearing run and a single connection never sees two open
// transactions at once.

// The projection/query layers (and `buildInList`) build named-parameter objects
// with BARE keys (`{ sessionId }`, `params["token0"]`) while the SQL references
// them as `$sessionId` / `$token0`. bun:sqlite's named binding requires the
// object keys to carry the SAME `$` sigil as the SQL placeholders; a bare key
// binds to NOTHING and silently yields NULL. Normalize every bound key to the
// `$` form (idempotent) so the documented bare-key SqlParams contract holds.
function bindable(values: SqlParams): Record<string, SqlParams[string]> {
  const bound: Record<string, SqlParams[string]> = {};
  for (const [key, value] of Object.entries(values)) {
    bound[key.startsWith("$") ? key : `$${key}`] = value;
  }
  return bound;
}

export function selectOne<T extends JsonRow>(
  connection: SqliteConnection,
  sql: string,
  values?: SqlParams,
): Promise<T | undefined> {
  const row = connection.query<T, SqlParams>(sql).get(bindable(values ?? {}));
  return Promise.resolve(row ?? undefined);
}

export function selectRows<T extends JsonRow>(
  connection: SqliteConnection,
  sql: string,
  values?: SqlParams,
): Promise<T[]> {
  return Promise.resolve(connection.query<T, SqlParams>(sql).all(bindable(values ?? {})));
}

/**
 * Execute a write. Named-param writes go through a prepared statement
 * (`Database.run` binds positional params only); paramless statements
 * (begin/commit/pragma) run directly.
 */
export function run(connection: SqliteConnection, sql: string, values?: SqlParams): Promise<void> {
  if (values === undefined) {
    connection.run(sql);
  } else {
    connection.query<unknown, SqlParams>(sql).run(bindable(values));
  }
  return Promise.resolve();
}
