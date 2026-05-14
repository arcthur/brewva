export class BoxPlaneError extends Error {
  constructor(
    message: string,
    readonly code:
      | "box_unavailable"
      | "box_capability_unsupported"
      | "box_exec_failed"
      | "box_scope_invalid"
      | "boxlite_sdk_unavailable",
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "BoxPlaneError";
  }
}
