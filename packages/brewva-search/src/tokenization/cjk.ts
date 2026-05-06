import { cutCjkRunForSearch, ensureJiebaWasmInitialized } from "../jieba/wasm.js";
import { CJK_MIN_LENGTH, CJK_NGRAM_SIZES } from "./options.js";

const CJK_RUN_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]+/gu;

export function collectCjkTokens(input: {
  normalized: string;
  includeCjkNgrams: boolean;
  addToken(token: string, minimumLength: number): void;
}): void {
  ensureJiebaWasmInitialized();
  for (const match of input.normalized.matchAll(CJK_RUN_PATTERN)) {
    const run = match[0];
    for (const token of cutCjkRunForSearch(run)) {
      input.addToken(token, CJK_MIN_LENGTH);
    }
    if (!input.includeCjkNgrams) {
      continue;
    }
    for (const ngram of buildCjkNgrams(run)) {
      input.addToken(ngram, CJK_MIN_LENGTH);
    }
  }
}

function buildCjkNgrams(value: string): string[] {
  const chars = Array.from(value);
  const ngrams: string[] = [];
  for (const size of CJK_NGRAM_SIZES) {
    if (chars.length < size) {
      continue;
    }
    for (let index = 0; index <= chars.length - size; index += 1) {
      ngrams.push(chars.slice(index, index + size).join(""));
    }
  }
  return ngrams;
}
