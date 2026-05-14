import type { CliShellOverlayPayload } from "./overlays/payloads.js";
import type { CliShellViewState } from "./state.js";
export { projectShellViewModel, type ShellViewModel } from "./view-model.js";

export function selectActiveOverlayPayload(
  state: CliShellViewState,
): CliShellOverlayPayload | undefined {
  return state.overlay.active?.payload;
}

export function selectHasCompletion(state: CliShellViewState): boolean {
  return Boolean(state.composer.completion);
}

export function selectTranscriptScrollState(state: CliShellViewState): {
  readonly followMode: "live" | "scrolled";
  readonly scrollOffset: number;
} {
  return {
    followMode: state.transcript.followMode,
    scrollOffset: state.transcript.scrollOffset,
  };
}
