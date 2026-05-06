const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/u;

export function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function containsCjk(value: string): boolean {
  return CJK_PATTERN.test(value);
}
