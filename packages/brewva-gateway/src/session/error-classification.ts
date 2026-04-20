export function normalizeRuntimeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  return "unknown_error";
}

export function looksLikeMaxOutputError(error: unknown): boolean {
  const message = normalizeRuntimeError(error).toLowerCase();
  return (
    message.includes("max_output") ||
    message.includes("max output") ||
    message.includes("output token") ||
    message.includes("response too long") ||
    message.includes("length finish reason")
  );
}

export function looksLikeRetryableProviderError(error: unknown): boolean {
  const message = normalizeRuntimeError(error).toLowerCase();
  if (looksLikeMaxOutputError(error)) {
    return false;
  }
  return /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|529|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|timed? out|timeout|terminated|retry delay/u.test(
    message,
  );
}
