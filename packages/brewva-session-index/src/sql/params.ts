export type SqlValue = string | number | null;
export type SqlParams = Record<string, SqlValue>;

export function buildInList(prefix: string, values: readonly string[], params: SqlParams): string {
  return values
    .map((value, index) => {
      const key = `${prefix}${index}`;
      params[key] = value;
      return `$${key}`;
    })
    .join(", ");
}
