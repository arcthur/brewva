export type BrewvaResourceStatus = "ok" | "unavailable";

export interface BrewvaResourceReadResult {
  readonly status: BrewvaResourceStatus;
  readonly uri: string;
  readonly path?: string;
  readonly mediaType?: string;
  readonly content?: string;
  readonly reason?: string;
}

export interface BrewvaResourceProvider {
  readonly scheme: string;
  read(uri: string): Promise<BrewvaResourceReadResult> | BrewvaResourceReadResult;
}
