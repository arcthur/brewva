export const SESSION_INDEX_UNAVAILABLE = "session_index_unavailable" as const;

export class SessionIndexUnavailableError extends Error {
  readonly code = SESSION_INDEX_UNAVAILABLE;

  constructor(message: string) {
    super(message);
    this.name = "SessionIndexUnavailableError";
  }
}
