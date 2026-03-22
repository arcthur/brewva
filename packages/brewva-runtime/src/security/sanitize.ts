import { CONTEXT_SOURCES } from "../context/sources.js";

/**
 * Patterns that indicate direct prompt-injection attempts.
 * Matching is case-insensitive.
 */
const SUSPICIOUS_PATTERNS: RegExp[] = [
  // --- original patterns ---
  /ignore previous instructions/gi,
  /system prompt/gi,
  /developer instructions/gi,
  /run this command exactly/gi,
  /tool_call\(/gi,
  /bypass security/gi,

  // --- extraction / exfiltration ---
  /repeat everything above/gi,
  /output your instructions/gi,
  /print your (system|initial|original) (prompt|instructions|message)/gi,
  /what (are|were) your instructions/gi,
  /show me your (hidden|secret|internal) (prompt|instructions)/gi,
  /reveal your (system|secret|original) (prompt|instructions|message)/gi,
  /disclose your (prompt|instructions|configuration)/gi,
  /display the (system|developer) (prompt|message)/gi,

  // --- override / role hijacking ---
  /forget (all |your )?(previous|prior|above|earlier) (instructions|context|rules)/gi,
  /disregard (all |your )?(previous|prior|above|earlier) (instructions|context|rules)/gi,
  /override (your |all )?(instructions|rules|guidelines)/gi,
  /you are now a/gi,
  /new instructions:/gi,
  /act as (a |an )?(unrestricted|unfiltered|jailbroken)/gi,
  /enter (developer|debug|admin|god) mode/gi,

  // --- compaction-targeted injection ---
  /include (this|the following) [\w ]*in (your |the )?(summary|compaction)/gi,
  /when (you )?summariz/gi,
  /in (your |the )?(compacted|compressed|summarized) (output|version|context)/gi,
  /preserve (this|the following) (across|through|after) compaction/gi,

  // --- tool / function manipulation ---
  /call (the )?function/gi,
  /execute (the )?(following |this )?(command|code|script)/gi,
  /\bfunction_call\b/gi,
];

export function sanitizeContextText(text: string): string {
  let output = text;
  for (const pattern of SUSPICIOUS_PATTERNS) {
    output = output.replace(pattern, "[redacted]");
  }
  return output;
}

/**
 * Trust tiers for context injection sources.
 *
 * - `system`:   Runtime-generated, trusted content (identity, task state, gates).
 * - `internal`: Runtime-derived status and routing context.
 * - `external`: Content that originated outside the runtime boundary.
 */
export type SourceTrustTier = "system" | "internal" | "external";

const SOURCE_TRUST_MAP: Record<string, SourceTrustTier> = {
  [CONTEXT_SOURCES.identity]: "system",
  [CONTEXT_SOURCES.taskState]: "system",
  [CONTEXT_SOURCES.runtimeStatus]: "internal",
  [CONTEXT_SOURCES.workflowAdvisory]: "internal",
  [CONTEXT_SOURCES.toolOutputsDistilled]: "internal",
  [CONTEXT_SOURCES.projectionWorking]: "internal",
};

export function getSourceTrustTier(source: string): SourceTrustTier {
  return SOURCE_TRUST_MAP[source] ?? "external";
}

/**
 * Apply source-aware sanitization with pattern redaction.
 *
 * - `system`:   no sanitization (runtime-generated).
 * - `internal`: standard pattern-based sanitization.
 * - `external`: standard sanitization + structural boundary wrapping.
 */
export function sanitizeByTrust(text: string, source: string): string {
  const tier = getSourceTrustTier(source);
  if (tier === "system") {
    return text;
  }
  const sanitized = sanitizeContextText(text);
  if (tier === "external") {
    return wrapWithBoundary(sanitized, source);
  }
  return sanitized;
}

/**
 * Apply structural boundary wrapping only (no pattern redaction).
 * Used when `sanitizeContext` is disabled but structural isolation
 * for external sources is still desired.
 */
export function wrapByTrust(text: string, source: string): string {
  const tier = getSourceTrustTier(source);
  if (tier === "external") {
    return wrapWithBoundary(text, source);
  }
  return text;
}

/**
 * Wrap external content with structural boundary markers so the LLM
 * can distinguish user/external data from system instructions.
 */
function wrapWithBoundary(content: string, source: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";
  return `<context-data source="${source}">\n${trimmed}\n</context-data>`;
}
