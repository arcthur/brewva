import { TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";
import type { BrewvaBundledToolRuntime } from "../../../contracts/index.js";
import { recordToolRuntimeEvent } from "../../../runtime-port/extensions.js";
import { buildReadPathDiscoveryObservationPayload } from "../read-path-discovery.js";

export const SOURCE_INTELLIGENCE_EVENT_TYPE = "tool_source_intelligence";

export type SourceIntelligenceEventPayload =
  | {
      readonly toolName: "code_outline";
      readonly operation: "outline";
      readonly filePath: string;
      readonly language: string;
      readonly declarationsCount: number;
      readonly importsCount: number;
      readonly callsCount: number;
      readonly diagnosticsCount: number;
      readonly durationMs: number;
    }
  | {
      readonly toolName: "code_digest";
      readonly operation: "digest";
      readonly roots: readonly string[];
      readonly query?: string;
      readonly files: number;
      readonly totalFiles: number;
      readonly budgetTokens: number;
      readonly durationMs: number;
    }
  | {
      readonly toolName: "code_surface";
      readonly operation: "surface";
      readonly path: string;
      readonly declarationsCount: number;
      readonly reExportsCount: number;
    }
  | {
      readonly toolName: "code_deps" | "code_reverse_deps";
      readonly operation: "deps" | "reverse_deps";
      readonly edges: number;
      readonly roots: readonly string[];
    }
  | {
      readonly toolName: "code_cycles";
      readonly operation: "cycles";
      readonly cycles: number;
      readonly roots: readonly string[];
    }
  | {
      readonly toolName: "code_callers" | "code_callees";
      readonly operation: "callers" | "callees";
      readonly symbol: string;
      readonly filePath?: string;
      readonly edges: number;
      readonly ambiguousEdges: number;
    };

export function recordSourceIntelligenceReadPathObservation(input: {
  readonly runtime?: BrewvaBundledToolRuntime;
  readonly sessionId?: string;
  readonly baseCwd: string;
  readonly toolName: string;
  readonly evidenceKind: string;
  readonly observedPaths: Iterable<string>;
}): void {
  const payload = buildReadPathDiscoveryObservationPayload({
    baseCwd: input.baseCwd,
    toolName: input.toolName,
    evidenceKind: input.evidenceKind,
    observedPaths: input.observedPaths,
  });
  if (!input.sessionId || !payload) {
    return;
  }
  recordToolRuntimeEvent(input.runtime, {
    sessionId: input.sessionId,
    type: TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
    payload,
  });
}

export function recordSourceIntelligenceEvent(
  runtime: BrewvaBundledToolRuntime | undefined,
  sessionId: string | undefined,
  payload: SourceIntelligenceEventPayload,
): void {
  if (!sessionId) return;
  recordToolRuntimeEvent(runtime, {
    sessionId,
    type: SOURCE_INTELLIGENCE_EVENT_TYPE,
    payload,
  });
}
