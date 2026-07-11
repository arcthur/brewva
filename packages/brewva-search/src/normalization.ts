import { compactWhitespace } from "@brewva/brewva-std/text";

const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/u;

export function normalizeSearchText(value: string): string {
  return compactWhitespace(value.toLowerCase());
}

export function containsCjk(value: string): boolean {
  return CJK_PATTERN.test(value);
}
