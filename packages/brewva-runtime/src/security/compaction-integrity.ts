/**
 * Compaction integrity validation.
 *
 * Checks whether a compaction summary contains content that should not
 * survive compaction, such as leaked system prompts or injected instructions.
 */

const COMPACTION_LEAK_PATTERNS: RegExp[] = [
  // System prompt / instruction leakage indicators
  /you are a/gi,
  /your (system|initial|original|hidden) (prompt|instructions|message)/gi,
  /\bsystem prompt\b/gi,
  /\bdeveloper instructions\b/gi,
  /\bsystem message\b/gi,

  // Instruction-like content that should not appear in a factual summary
  /ignore previous instructions/gi,
  /disregard (all |your )?(previous|prior) instructions/gi,
  /override (your |all )?instructions/gi,
  /new instructions:/gi,

  // Verbatim reproduction markers (hallmarks of prompt extraction)
  /\bverbatim\b/gi,
  /\bexact copy\b/gi,
  /\bword for word\b/gi,
  /above (is|was|are|were) (the|my|your) (instructions|prompt|system)/gi,

  // Tool/function injection
  /tool_call\(/gi,
  /\bfunction_call\b/gi,
  /execute (the )?(following |this )?(command|code|script)/gi,
];

export interface CompactionIntegrityResult {
  clean: boolean;
  violations: string[];
}

/**
 * Validate a compaction summary for signs of prompt injection or leakage.
 * Returns `clean: true` if no issues are detected.
 */
export function validateCompactionSummary(summary: string): CompactionIntegrityResult {
  const trimmed = summary.trim();
  if (!trimmed) {
    return { clean: true, violations: [] };
  }

  const violations: string[] = [];
  for (const pattern of COMPACTION_LEAK_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    if (pattern.test(trimmed)) {
      violations.push(pattern.source);
    }
  }

  return {
    clean: violations.length === 0,
    violations,
  };
}

/**
 * Sanitize a compaction summary by redacting detected violations.
 */
export function sanitizeCompactionSummary(summary: string): string {
  let output = summary;
  for (const pattern of COMPACTION_LEAK_PATTERNS) {
    output = output.replace(pattern, "[compaction-redacted]");
  }
  return output;
}
