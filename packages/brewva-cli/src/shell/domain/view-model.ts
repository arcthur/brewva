import { cloneCockpitObservationCursor, shareShellCockpitProjection } from "./cockpit/index.js";
import { cloneCliShellPromptParts } from "./prompt-parts.js";
import type { CliShellCompletionState, CliShellViewState } from "./state.js";

export type ShellViewModel = CliShellViewState;
export type { CliShellNotification } from "./state.js";

function projectCompletion(
  completion: CliShellCompletionState | undefined,
): CliShellCompletionState | undefined {
  if (!completion) {
    return undefined;
  }
  return {
    ...completion,
    items: [...completion.items],
  };
}

/**
 * Branch container clones are load-bearing, not defensive style: the Solid
 * store in `useShellState` ADOPTS the first projection as its mutable
 * backing and `reconcile` mutates adopted containers in place on later
 * emits. Sharing the reducer-owned containers with the store would let
 * reconcile mutate live domain state. Leaf objects (messages, queue items)
 * may be shared because the reducer replaces them immutably and reconcile
 * only mutates objects whose replacement differs.
 */
type ViewStateBranchKey =
  | "focus"
  | "overlay"
  | "transcript"
  | "surface"
  | "composer"
  | "pager"
  | "notifications"
  | "queue"
  | "cockpit"
  | "operator"
  | "subagentFooter"
  | "status"
  | "diff"
  | "view";

const BRANCH_PROJECTIONS: {
  readonly [Key in ViewStateBranchKey]: (state: CliShellViewState) => ShellViewModel[Key];
} = {
  focus: (state) => ({
    active: state.focus.active,
    returnStack: [...state.focus.returnStack],
  }),
  overlay: (state) => ({
    active: state.overlay.active,
    queue: [...state.overlay.queue],
  }),
  transcript: (state) => ({
    ...state.transcript,
    messages: [...state.transcript.messages],
  }),
  surface: (state) => ({
    ...state.surface,
    navigationRequest: state.surface.navigationRequest
      ? { ...state.surface.navigationRequest }
      : undefined,
  }),
  composer: (state) => ({
    ...state.composer,
    parts: cloneCliShellPromptParts(state.composer.parts),
    completion: projectCompletion(state.composer.completion),
  }),
  pager: (state) =>
    state.pager ? { title: state.pager.title, lines: [...state.pager.lines] } : undefined,
  notifications: (state) => [...state.notifications],
  queue: (state) => [...state.queue],
  cockpit: (state) => ({
    projection: state.cockpit.projection
      ? shareShellCockpitProjection(state.cockpit.projection)
      : undefined,
    observation: cloneCockpitObservationCursor(state.cockpit.observation),
  }),
  operator: (state) => ({
    taskRuns: [...state.operator.taskRuns],
  }),
  subagentFooter: (state) => ({
    mode: state.subagentFooter.mode,
    selectedRunId: state.subagentFooter.selectedRunId,
    scrollOffset: state.subagentFooter.scrollOffset,
  }),
  status: (state) => ({
    ...state.status,
    entries: { ...state.status.entries },
  }),
  diff: (state) => ({ ...state.diff }),
  view: (state) => ({ ...state.view }),
};

const BRANCH_KEYS = Object.keys(BRANCH_PROJECTIONS) as readonly ViewStateBranchKey[];

/** One-shot full projection: every branch is freshly cloned. */
export function projectShellViewModel(state: CliShellViewState): ShellViewModel {
  return createShellViewModelProjector()(state);
}

function assignBranch<Key extends ViewStateBranchKey>(
  projection: ShellViewModel,
  key: Key,
  value: ShellViewModel[Key],
): void {
  projection[key] = value;
}

/**
 * Structurally shared projection. The reducer is immutable, so a branch
 * whose state slice is referentially unchanged since the previous call is
 * reused from the previous projection instead of being re-cloned. The
 * renderer's reconcile pass then short-circuits untouched branches on
 * reference identity, dropping per-emit diff cost from O(state) to
 * O(changed branches). Calling with an identical state object returns the
 * identical projection object.
 */
export function createShellViewModelProjector(): (state: CliShellViewState) => ShellViewModel {
  let lastState: CliShellViewState | undefined;
  let lastProjection: ShellViewModel | undefined;

  return (state) => {
    if (lastState === state && lastProjection) {
      return lastProjection;
    }
    const previousState = lastState;
    const previousProjection = lastProjection;
    const projection = { ...state } as ShellViewModel;
    for (const key of BRANCH_KEYS) {
      if (previousState && previousProjection && previousState[key] === state[key]) {
        assignBranch(projection, key, previousProjection[key]);
      } else {
        assignBranch(projection, key, BRANCH_PROJECTIONS[key](state));
      }
    }
    lastState = state;
    lastProjection = projection;
    return projection;
  };
}
