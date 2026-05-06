import type { JsonRow } from "../duckdb/query.js";
import type { SqlParams } from "../sql/params.js";

export type { JsonRow };

export interface SessionIndexQueryPort {
  ensureAvailable(): Promise<void>;
  selectOne<T extends JsonRow>(sql: string, values?: SqlParams): Promise<T | undefined>;
  selectRows<T extends JsonRow>(sql: string, values?: SqlParams): Promise<T[]>;
}
