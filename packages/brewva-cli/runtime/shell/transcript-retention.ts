import { createMemo } from "solid-js";
import type { Accessor } from "solid-js";
import type {
  CliShellTranscriptMessage,
  CliShellTranscriptPart,
} from "../../src/shell/domain/transcript.js";

const INTERACTIVE_TRANSCRIPT_ROW_LIMIT = 100;

export interface RetainedTranscriptRows {
  stableRows: readonly CliShellTranscriptMessage[];
  liveRows: readonly CliShellTranscriptMessage[];
}

export interface RetainedTranscriptRowAccessors {
  stableRows: Accessor<readonly CliShellTranscriptMessage[]>;
  liveRows: Accessor<readonly CliShellTranscriptMessage[]>;
  rows: Accessor<readonly CliShellTranscriptMessage[]>;
  stableCount: Accessor<number>;
  liveCount: Accessor<number>;
  rowCount: Accessor<number>;
}

function isStreamingPart(part: CliShellTranscriptPart): boolean {
  return part.renderMode === "streaming";
}

function isStreamingMessage(message: CliShellTranscriptMessage): boolean {
  return message.renderMode === "streaming" || message.parts.some(isStreamingPart);
}

function sameRows(
  left: readonly CliShellTranscriptMessage[],
  right: readonly CliShellTranscriptMessage[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

export function splitRetainedTranscriptRows(
  messages: readonly CliShellTranscriptMessage[],
  rowLimit = INTERACTIVE_TRANSCRIPT_ROW_LIMIT,
): RetainedTranscriptRows {
  const liveStartIndex = messages.findIndex(isStreamingMessage);
  const boundedRowLimit = Math.max(1, Math.floor(rowLimit));
  if (liveStartIndex < 0) {
    const start = Math.max(0, messages.length - boundedRowLimit);
    return {
      stableRows: messages.slice(start),
      liveRows: [],
    };
  }
  const stableRows = messages.slice(0, liveStartIndex);
  const liveRows = messages.slice(liveStartIndex);
  const stableLimit = Math.max(0, boundedRowLimit - liveRows.length);
  const retainedStableStart = Math.max(0, stableRows.length - stableLimit);
  return {
    stableRows: stableRows.slice(retainedStableStart),
    liveRows,
  };
}

export function createRetainedTranscriptRows(
  messages: Accessor<readonly CliShellTranscriptMessage[]>,
  rowLimit: Accessor<number> = () => INTERACTIVE_TRANSCRIPT_ROW_LIMIT,
): RetainedTranscriptRowAccessors {
  const rows = createMemo<RetainedTranscriptRows>(
    (previous) => {
      const next = splitRetainedTranscriptRows(messages(), rowLimit());
      const stableRows =
        previous && sameRows(previous.stableRows, next.stableRows)
          ? previous.stableRows
          : [...next.stableRows];
      const liveRows =
        previous && sameRows(previous.liveRows, next.liveRows)
          ? previous.liveRows
          : [...next.liveRows];
      if (previous && previous.stableRows === stableRows && previous.liveRows === liveRows) {
        return previous;
      }
      return {
        stableRows,
        liveRows,
      };
    },
    { stableRows: [], liveRows: [] },
  );
  const combinedRows = createMemo<readonly CliShellTranscriptMessage[]>((previous) => {
    const next = [...rows().stableRows, ...rows().liveRows];
    return previous && sameRows(previous, next) ? previous : next;
  }, []);

  return {
    stableRows: () => rows().stableRows,
    liveRows: () => rows().liveRows,
    rows: combinedRows,
    stableCount: () => rows().stableRows.length,
    liveCount: () => rows().liveRows.length,
    rowCount: () => rows().stableRows.length + rows().liveRows.length,
  };
}
