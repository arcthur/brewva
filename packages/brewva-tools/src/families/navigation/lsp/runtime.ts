import { readFileSync, realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE } from "@brewva/brewva-runtime/protocol";
import type { BrewvaBundledToolRuntime } from "../../../contracts/index.js";
import { recordToolRuntimeEvent } from "../../../runtime-port/extensions.js";
import type { ParallelReadConfig } from "../../../runtime-port/parallel-read.js";
import { walkWorkspaceFiles } from "../internal/workspace-walk.js";
import type { ParsedSource } from "../parsing/index.js";
import { isParsableFile } from "../parsing/language.js";
import { buildReadPathDiscoveryObservationPayload } from "../read-path-discovery.js";

export type ParsingRuntime = typeof import("../parsing/index.js");

let parsingRuntimePromise: Promise<ParsingRuntime> | undefined;

export function loadParsingRuntime(): Promise<ParsingRuntime> {
  parsingRuntimePromise ??= import("../parsing/index.js");
  return parsingRuntimePromise;
}

export interface AstScanContext {
  runtime?: BrewvaBundledToolRuntime;
  sessionId?: string;
  toolName: string;
  config: ParallelReadConfig;
}

export function recordLspDiscoveryObservation(input: {
  runtime?: BrewvaBundledToolRuntime;
  sessionId?: string;
  baseCwd: string;
  toolName: string;
  evidenceKind: string;
  observedPaths: Iterable<string>;
}): void {
  const payload = buildReadPathDiscoveryObservationPayload({
    baseCwd: input.baseCwd,
    toolName: input.toolName,
    evidenceKind: input.evidenceKind,
    observedPaths: input.observedPaths,
  });
  if (!input.sessionId || !payload) return;
  recordToolRuntimeEvent(input.runtime, {
    sessionId: input.sessionId,
    type: TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
    payload,
  });
}

export function walkParsableFiles(rootDir: string, maxFiles = 4000): string[] {
  return walkWorkspaceFiles({
    roots: [rootDir],
    maxFiles,
    isMatch: (filePath) => isParsableFile(filePath),
    includeRootFiles: false,
  }).files;
}

export function stableParsableWalkOrder(paths: readonly string[], hint?: string): string[] {
  const canonicalKey = (candidate: string): string => {
    try {
      return realpathSync(candidate);
    } catch {
      return resolvePath(candidate);
    }
  };
  const sorted = [...paths].toSorted((a, b) => a.localeCompare(b));
  if (!hint) return sorted;
  const hintKey = canonicalKey(hint);
  let idx = -1;
  for (let i = 0; i < sorted.length; i += 1) {
    const p = sorted[i];
    if (p && canonicalKey(p) === hintKey) {
      idx = i;
      break;
    }
  }
  if (idx <= 0) return sorted;
  const chosen = sorted[idx]!;
  return [chosen, ...sorted.filter((_p, i) => i !== idx)];
}

export function safeParse(
  parsing: ParsingRuntime,
  filePath: string,
  sourceText: string,
): ParsedSource | null {
  try {
    return parsing.parseSource(filePath, sourceText);
  } catch {
    return null;
  }
}

export async function readAndParse(filePath: string): Promise<ParsedSource | null> {
  if (!isParsableFile(filePath)) return null;
  let sourceText: string;
  try {
    sourceText = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  return safeParse(await loadParsingRuntime(), filePath, sourceText);
}
