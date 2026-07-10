import type { CliShellTranscriptToolStatus } from "../../src/shell/domain/transcript.js";

/**
 * Resolve the foreground tone for a single-line (`InlineTool`) tool row.
 *
 * Pillar 1a of the streaming-transcript legibility work: a completed, successful
 * tool row recedes to the muted color so the surrounding narration leads. Errors
 * stay error-colored, pending/running rows keep their safety-derived tone, and an
 * actionable row lights to the accent on hover to signal it is still clickable.
 *
 * Pure string-in / string-out so it is unit-testable without a renderer. The
 * caller pre-computes `fallbackColor` (the safety-tone color) and passes the theme
 * colors it needs, keeping this helper free of palette/opentui imports.
 *
 * Precedence (first match wins): error → actionable-hover → completed → fallback.
 */
export function resolveInlineToolTone(input: {
  readonly status: CliShellTranscriptToolStatus;
  readonly hovered: boolean;
  readonly actionable: boolean;
  readonly mutedColor: string;
  readonly accentColor: string;
  readonly errorColor: string;
  readonly fallbackColor: string;
}): string {
  if (input.status === "error") {
    return input.errorColor;
  }
  if (input.hovered && input.actionable) {
    return input.accentColor;
  }
  if (input.status === "completed") {
    return input.mutedColor;
  }
  return input.fallbackColor;
}
