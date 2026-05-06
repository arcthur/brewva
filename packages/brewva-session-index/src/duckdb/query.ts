import type { SqlParams } from "../sql/params.js";
import type { DuckDBConnection } from "./instance.js";

export type JsonRow = object;

export async function selectOne<T extends JsonRow>(
  connection: DuckDBConnection,
  sql: string,
  values?: SqlParams,
): Promise<T | undefined> {
  return (await selectRows<T>(connection, sql, values))[0];
}

export async function selectRows<T extends JsonRow>(
  connection: DuckDBConnection,
  sql: string,
  values?: SqlParams,
): Promise<T[]> {
  const result = await connection.run(sql, values);
  return (await result.getRowObjectsJS()) as T[];
}
