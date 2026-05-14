export interface ViewportState {
  itemCount: number;
  visibleCount: number;
  offset: number;
}

export function createViewportState(itemCount: number, visibleCount: number): ViewportState {
  const boundedVisible = Math.max(1, Math.trunc(visibleCount));
  const boundedCount = Math.max(0, Math.trunc(itemCount));
  const maxOffset = Math.max(0, boundedCount - boundedVisible);
  return {
    itemCount: boundedCount,
    visibleCount: boundedVisible,
    offset: maxOffset,
  };
}

export function scrollViewport(state: ViewportState, delta: number): ViewportState {
  const maxOffset = Math.max(0, state.itemCount - state.visibleCount);
  const nextOffset = Math.max(0, Math.min(maxOffset, state.offset + Math.trunc(delta)));
  return {
    ...state,
    offset: nextOffset,
  };
}
