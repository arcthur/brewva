import { createContext, useContext } from "solid-js";

/**
 * Per-row spacing signal for the transcript (Pillar 1b). A tool row that packs
 * against the previous same-turn tool row provides `compactTop: () => true` so its
 * single-line (`InlineTool`) top margin collapses and the rows form a list;
 * `BlockTool` ignores this and keeps its own margin so multi-line output blocks stay
 * separated.
 *
 * `compactTop` is an accessor (not a plain boolean) so it stays reactive across the
 * context boundary: the consumer calls it inside a tracking scope, so a mid-stream
 * change to the projected hint updates the margin without remounting the row.
 *
 * Default `() => false` preserves the standard one-line gap wherever the provider is
 * absent (every non-packed row, and the scrollback pager path).
 */
export interface TranscriptRowSpacing {
  readonly compactTop: () => boolean;
}

const TranscriptRowSpacingContext = createContext<TranscriptRowSpacing>({
  compactTop: () => false,
});

export const TranscriptRowSpacingProvider = TranscriptRowSpacingContext.Provider;

export function useTranscriptRowSpacing(): TranscriptRowSpacing {
  return useContext(TranscriptRowSpacingContext);
}
