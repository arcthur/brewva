import { closeSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface ForEachUtf8LineSyncOptions {
  readonly chunkSize?: number;
}

function normalizeChunkSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 1024 * 1024;
  }
  return Math.max(1, Math.trunc(value));
}

export function forEachUtf8LineSync(
  filePath: string,
  visit: (line: string, lineNumber: number) => void,
  options: ForEachUtf8LineSyncOptions = {},
): void {
  const fd = openSync(resolve(filePath), "r");
  const chunk = Buffer.allocUnsafe(normalizeChunkSize(options.chunkSize));
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let lineNumber = 1;

  const visitLine = (line: string) => {
    visit(line.endsWith("\r") ? line.slice(0, -1) : line, lineNumber);
    lineNumber += 1;
  };

  try {
    while (true) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        break;
      }
      pending += decoder.write(chunk.subarray(0, bytesRead));
      let lineStart = 0;
      while (true) {
        const newlineIndex = pending.indexOf("\n", lineStart);
        if (newlineIndex === -1) {
          pending = pending.slice(lineStart);
          break;
        }
        visitLine(pending.slice(lineStart, newlineIndex));
        lineStart = newlineIndex + 1;
      }
    }

    pending += decoder.end();
    if (pending.length > 0) {
      visitLine(pending);
    }
  } finally {
    closeSync(fd);
  }
}
