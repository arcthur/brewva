/**
 * Stable product protocols shared by gateway, CLI, tools, recall, and session-index.
 * Runtime authority stays in the four-port root; this module carries wire/data shapes only.
 */
export * from "./body.js";
export * from "./types/effect-commitment.js";
export * from "./types/session-rewind.js";
