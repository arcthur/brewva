export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error === undefined || error === null) {
    return "unknown error";
  }
  try {
    const serialized = JSON.stringify(error);
    if (typeof serialized === "string") {
      return serialized;
    }
  } catch {
    // fall through
  }
  return "non-serializable error";
}
