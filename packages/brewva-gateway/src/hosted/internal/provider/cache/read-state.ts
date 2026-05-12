export interface ReadStateKey {
  path: string;
  offset: number;
  limit: number | null;
  encoding: string;
}

export interface ReadStateSignature {
  size: number;
  mtimeMs: number;
  contentHash: string | null;
}

export interface ReadUnchangedMatch {
  status: "unchanged";
  previousReadId: string;
  visibleHistoryEpoch: number;
}

interface ReadStateRecord {
  key: ReadStateKey;
  signature: ReadStateSignature;
  visibleHistoryEpoch: number;
  readId: string;
}

export interface ReadUnchangedState {
  match(input: {
    sessionId: string;
    key: ReadStateKey;
    signature: ReadStateSignature;
    visibleHistoryEpoch: number;
  }): ReadUnchangedMatch | undefined;
  recordFullRead(input: {
    sessionId: string;
    key: ReadStateKey;
    signature: ReadStateSignature;
    visibleHistoryEpoch: number;
    readId: string;
  }): void;
  clear(sessionId?: string): void;
}

export function createReadUnchangedState(): ReadUnchangedState {
  const records = new Map<string, ReadStateRecord>();
  return {
    match(input) {
      const record = records.get(buildRecordKey(input.sessionId, input.key));
      if (!record) {
        return undefined;
      }
      if (record.visibleHistoryEpoch !== input.visibleHistoryEpoch) {
        return undefined;
      }
      if (!sameSignature(record.signature, input.signature)) {
        return undefined;
      }
      return {
        status: "unchanged",
        previousReadId: record.readId,
        visibleHistoryEpoch: record.visibleHistoryEpoch,
      };
    },
    recordFullRead(input) {
      records.set(buildRecordKey(input.sessionId, input.key), {
        key: { ...input.key },
        signature: { ...input.signature },
        visibleHistoryEpoch: input.visibleHistoryEpoch,
        readId: input.readId,
      });
    },
    clear(sessionId) {
      if (!sessionId) {
        records.clear();
        return;
      }
      for (const key of records.keys()) {
        if (key.startsWith(`${sessionId}\0`)) {
          records.delete(key);
        }
      }
    },
  };
}

function buildRecordKey(sessionId: string, key: ReadStateKey): string {
  return [
    sessionId,
    key.path,
    String(Math.max(0, Math.trunc(key.offset))),
    key.limit === null ? "none" : String(Math.max(0, Math.trunc(key.limit))),
    key.encoding,
  ].join("\0");
}

function sameSignature(left: ReadStateSignature, right: ReadStateSignature): boolean {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.contentHash === right.contentHash
  );
}
