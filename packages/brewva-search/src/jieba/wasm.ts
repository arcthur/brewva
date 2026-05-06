import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cut_for_search as cutForSearch, initSync } from "jieba-wasm/web";

const JIEBA_WASM_FILENAME = "jieba_rs_wasm_bg.wasm";
const requireFromModule = createRequire(import.meta.url);

let jiebaInitialized = false;

export function cutCjkRunForSearch(value: string): string[] {
  ensureJiebaWasmInitialized();
  return cutForSearch(value, true);
}

export function ensureJiebaWasmInitialized(): void {
  if (jiebaInitialized) {
    return;
  }
  const wasmPath = resolveJiebaWasmPath();
  initSync({ module: readFileSync(wasmPath) });
  jiebaInitialized = true;
}

function resolveJiebaWasmPath(): string {
  for (const candidate of listJiebaWasmPathCandidates()) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `jieba-wasm asset is missing. Expected ${JIEBA_WASM_FILENAME} beside the Brewva binary or in the jieba-wasm package.`,
  );
}

function listJiebaWasmPathCandidates(): string[] {
  const candidates = [join(dirname(process.execPath), JIEBA_WASM_FILENAME)];
  try {
    candidates.push(join(dirname(fileURLToPath(import.meta.url)), JIEBA_WASM_FILENAME));
  } catch {
    // Some bundled runtimes expose non-file import.meta.url values.
  }
  try {
    candidates.push(
      join(dirname(requireFromModule.resolve("jieba-wasm/web")), JIEBA_WASM_FILENAME),
    );
  } catch {
    // The explicit failure happens in resolveJiebaWasmPath after all candidates are exhausted.
  }
  return candidates;
}
