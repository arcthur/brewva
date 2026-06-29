// Local mirror of the `@ff-labs/fff-bun` public surface the engine uses.
//
// The published package points its `types` entry at raw `.ts` source whose
// relative imports omit file extensions, which fails brewva's strict NodeNext
// typecheck (TS2835) the moment tsc follows into it — and `skipLibCheck` does
// not help because the offending files are `.ts`, not `.d.ts`. Owning the types
// here, plus importing the runtime module through a type-erased specifier (see
// `fff-finder-cache.ts`), keeps tsc out of the dependency's source entirely.
//
// This is a deliberate subset of the upstream API (`packages/shared/fff-api.ts`),
// limited to exactly what the engine consumes. Extend it as usage grows.

export type FffResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type FffGrepMode = "plain" | "regex" | "fuzzy";

export interface FffGrepMatch {
  readonly relativePath: string;
  readonly lineNumber: number;
  readonly lineContent: string;
  readonly totalFrecencyScore: number;
}

export interface FffGrepResult {
  readonly items: FffGrepMatch[];
  readonly nextCursor: unknown;
  readonly regexFallbackError?: string;
}

export interface FffGrepOptions {
  readonly mode?: FffGrepMode;
  readonly smartCase?: boolean;
  readonly pageSize?: number;
}

export interface FffInitOptions {
  readonly basePath: string;
  readonly aiMode?: boolean;
  readonly frecencyDbPath?: string;
}

export interface FffFileFinder {
  destroy(): void;
  grep(query: string, options?: FffGrepOptions): FffResult<FffGrepResult>;
  waitForScan(timeoutMs?: number): Promise<FffResult<boolean>>;
  trackQuery(query: string, selectedFilePath: string): FffResult<boolean>;
}

export interface FffModule {
  readonly FileFinder: {
    isAvailable(): boolean;
    create(options: FffInitOptions): FffResult<FffFileFinder>;
  };
}
