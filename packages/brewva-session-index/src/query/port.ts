import type { SqlParams } from "../sql/params.js";

/** A query result row — engine-agnostic; any object shape the projection expects. */
export type JsonRow = object;

export interface SessionIndexQueryPort {
  ensureAvailable(): Promise<void>;
  selectOne<T extends JsonRow>(sql: string, values?: SqlParams): Promise<T | undefined>;
  selectRows<T extends JsonRow>(sql: string, values?: SqlParams): Promise<T[]>;
}
